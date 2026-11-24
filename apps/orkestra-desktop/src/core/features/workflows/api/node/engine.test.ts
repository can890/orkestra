import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuthoringApi, defineWorkflow, type WorkflowDefinition } from './authoring';
import {
  extractJsonResult,
  WorkflowEngine,
  type AgentStepExecutor,
  type AgentStepOutcome,
  type AgentStepRequest,
} from './engine';
import { WorkflowRunStore } from './store';

const O = createAuthoringApi(defineWorkflow);
const logger = { info: () => undefined, warn: () => undefined };

/** Elle ilerletilen saat. */
function clock(start = Date.UTC(2026, 0, 5, 8, 0, 0)) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

type Gate = { release(outcome?: Partial<AgentStepOutcome>): void };

/** Ajan adımlarını kaydeden, istenirse bekleten sahte yürütücü. */
function fakeAgents(options: { hold?: boolean; reports?: string[] } = {}) {
  const requests: AgentStepRequest[] = [];
  const followUps: string[] = [];
  const gates: Gate[] = [];
  const reports = [...(options.reports ?? [])];
  let conversation = 0;
  const executor: AgentStepExecutor = {
    async run(request) {
      requests.push(request);
      const conversationId = `conv-${(conversation += 1)}`;
      request.onConversation({ conversationId, projectId: 'p1', taskId: request.task ?? 't1' });
      const report = reports.shift() ?? `report from ${request.step}`;
      if (!options.hold) return { status: 'done', report, conversationId };
      return new Promise<AgentStepOutcome>((resolve) => {
        const onAbort = () =>
          resolve({
            status: 'failed',
            message: 'stopped',
            started: true,
            retryable: false,
            conversationId,
          });
        request.signal.addEventListener('abort', onAbort, { once: true });
        gates.push({
          release: (outcome) =>
            resolve({ status: 'done', report, conversationId, ...outcome } as AgentStepOutcome),
        });
      });
    },
    async followUp(request) {
      followUps.push(request.text);
      return {
        status: 'done',
        report: reports.shift() ?? '',
        conversationId: request.conversationId,
      };
    },
  };
  return { executor, requests, followUps, gates };
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orkestra-workflow-engine-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function makeEngine(
  definitions: WorkflowDefinition[],
  options: { agents?: AgentStepExecutor; now?: () => number } = {}
) {
  const engine = new WorkflowEngine({
    store: new WorkflowRunStore(directory),
    agents: options.agents ?? fakeAgents().executor,
    logger,
    autoTick: false,
    ...(options.now ? { now: options.now } : {}),
  });
  engine.setDefinitions(definitions.map((definition) => ({ definition, file: 'test.ts' })));
  return engine;
}

describe('WorkflowEngine', () => {
  it('memoizes completed steps and re-runs only the failed one on resume', async () => {
    const counts = { a: 0, b: 0 };
    let failB = true;
    const definition = O.workflow('memo', { version: 1 }, async () => {
      const a = await O.step('a', () => {
        counts.a += 1;
        return { value: 1 };
      });
      const b = await O.step('b', () => {
        counts.b += 1;
        if (failB) throw new Error('flaky');
        return 2;
      });
      return { a, b };
    });
    const engine = makeEngine([definition]);
    await engine.start();
    const started = await engine.startRun('memo', null);
    if (!started.ok) throw new Error(started.error);
    await engine.settled(started.runId);

    let run = engine.getRun(started.runId)!;
    expect(run.status).toBe('paused');
    expect(run.pauseKind).toBe('step');
    expect(run.error).toContain('flaky');
    expect(run.nextResumeAt).not.toBeNull();
    expect(run.entries.map((entry) => [entry.name, entry.status])).toEqual([
      ['a', 'completed'],
      ['b', 'failed'],
    ]);

    failB = false;
    expect(await engine.resume(started.runId)).toEqual({ ok: true });
    await engine.settled(started.runId);
    run = engine.getRun(started.runId)!;
    expect(run.status).toBe('completed');
    expect(run.result).toEqual({ a: { value: 1 }, b: 2 });
    expect(counts).toEqual({ a: 1, b: 2 });
    await engine.dispose();
  });

  it('auto-resumes a failed code step after resumeAfter', async () => {
    const time = clock();
    let attempts = 0;
    const definition = O.workflow('auto', { version: 1, resumeAfter: ['1 minute'] }, async () =>
      O.step('flaky', () => {
        attempts += 1;
        if (attempts < 2) throw new Error('not yet');
        return 'ok';
      })
    );
    const engine = makeEngine([definition], { now: time.now });
    await engine.start();
    const started = await engine.startRun('auto', null);
    if (!started.ok) throw new Error(started.error);
    await engine.settled(started.runId);
    expect(engine.getRun(started.runId)!.status).toBe('paused');

    await engine.tick();
    expect(engine.getRun(started.runId)!.status).toBe('paused');
    time.advance(61_000);
    await engine.tick();
    await engine.settled(started.runId);
    const run = engine.getRun(started.runId)!;
    expect(run.status).toBe('completed');
    expect(run.result).toBe('ok');
    expect(run.autoResumeCount).toBe(1);
    await engine.dispose();
  });

  it('retries a step in place when it asks for retries', async () => {
    let attempts = 0;
    const definition = O.workflow('retry', { version: 1 }, async () =>
      O.step(
        'x',
        () => {
          attempts += 1;
          if (attempts < 3) throw new Error('again');
          return attempts;
        },
        { retry: { times: 2, delay: 1 } }
      )
    );
    const engine = makeEngine([definition]);
    await engine.start();
    const started = await engine.startRun('retry', null);
    if (!started.ok) throw new Error(started.error);
    await engine.settled(started.runId);
    expect(engine.getRun(started.runId)!.result).toBe(3);
    await engine.dispose();
  });

  it('waits durably on ask, survives a restart and resumes with the answer', async () => {
    const counts = { before: 0, after: 0 };
    const definition = O.workflow('approve', { version: 1 }, async (payload) => {
      O.title(`Release ${(payload as { name: string }).name}`);
      await O.step('before', () => {
        counts.before += 1;
        return null;
      });
      const answer = await O.ask('ship', { title: 'Ship it?', choices: ['Ship', 'Hold'] });
      if (!answer || answer.choice !== 'Ship') return O.stop('held back');
      await O.step('after', () => {
        counts.after += 1;
        return null;
      });
      return 'shipped';
    });
    const questions: string[] = [];
    const first = new WorkflowEngine({
      store: new WorkflowRunStore(directory),
      agents: fakeAgents().executor,
      logger,
      autoTick: false,
      onQuestion: (_run, entry) => questions.push(entry.question!.title),
    });
    first.setDefinitions([{ definition, file: 'x.ts' }]);
    await first.start();
    const started = await first.startRun('approve', { name: 'v1' }, { key: 'v1' });
    if (!started.ok) throw new Error(started.error);
    await first.settled(started.runId);
    expect(first.getRun(started.runId)!.status).toBe('waiting');
    expect(first.getRun(started.runId)!.title).toBe('Release v1');
    expect(questions).toEqual(['Ship it?']);
    await first.dispose();

    // Yeni süreç: aynı kayıtlardan yeniden kurulan motor.
    const second = makeEngine([definition]);
    await second.start();
    expect(second.getRun(started.runId)!.status).toBe('waiting');
    expect(await second.answer(started.runId, 'ship', 'Nope')).toMatchObject({ ok: false });
    expect(await second.answer(started.runId, 'ship', 'Ship')).toEqual({ ok: true });
    await second.settled(started.runId);
    const run = second.getRun(started.runId)!;
    expect(run.status).toBe('completed');
    expect(run.result).toBe('shipped');
    expect(counts).toEqual({ before: 1, after: 1 });
    // Aynı anahtar yeni çalıştırma başlatmaz.
    expect(await second.startRun('approve', { name: 'v1' }, { key: 'v1' })).toMatchObject({
      ok: true,
      runId: started.runId,
      existing: true,
    });
    await second.dispose();
  });

  it('returns null from ask after its timeout and ends with stop', async () => {
    const time = clock();
    const definition = O.workflow('timeout', { version: 1 }, async () => {
      const answer = await O.ask('q', { title: 'Answer?', choices: ['yes'], timeout: '1 hour' });
      if (!answer) return O.stop('nobody answered');
      return 'answered';
    });
    const engine = makeEngine([definition], { now: time.now });
    await engine.start();
    const started = await engine.startRun('timeout', null);
    if (!started.ok) throw new Error(started.error);
    await engine.settled(started.runId);
    expect(engine.getRun(started.runId)!.status).toBe('waiting');
    time.advance(3_600_001);
    await engine.tick();
    await engine.settled(started.runId);
    const run = engine.getRun(started.runId)!;
    expect(run.status).toBe('stopped');
    expect(run.reason).toBe('nobody answered');
    await engine.dispose();
  });

  it('sleeps durably until its wake time', async () => {
    const time = clock();
    const definition = O.workflow('nap', { version: 1 }, async () => {
      await O.sleep('nap', '2 hours');
      return 'awake';
    });
    const engine = makeEngine([definition], { now: time.now });
    await engine.start();
    const started = await engine.startRun('nap', null);
    if (!started.ok) throw new Error(started.error);
    await engine.settled(started.runId);
    expect(engine.getRun(started.runId)!.status).toBe('waiting');
    time.advance(2 * 3_600_000);
    await engine.tick();
    await engine.settled(started.runId);
    expect(engine.getRun(started.runId)!.result).toBe('awake');
    await engine.dispose();
  });

  it('pauses after the running agent step finishes and resumes later', async () => {
    const agents = fakeAgents({ hold: true });
    let afterRuns = 0;
    const definition = O.workflow('pausable', { version: 1 }, async () => {
      const review = (await O.agent('review', {
        task: 't1',
        provider: 'claude',
        brief: 'Review it',
      })) as { value: string; conversation: string };
      await O.step('after', () => {
        afterRuns += 1;
        return review.value;
      });
      return review.conversation;
    });
    const engine = makeEngine([definition], { agents: agents.executor });
    await engine.start();
    const started = await engine.startRun('pausable', null);
    if (!started.ok) throw new Error(started.error);
    await vi_waitFor(() => agents.gates.length === 1);
    expect(engine.getRun(started.runId)!.entries[0]!.agent?.conversationId).toBe('conv-1');

    expect(await engine.pause(started.runId)).toEqual({ ok: true });
    agents.gates[0]!.release();
    await engine.settled(started.runId);
    let run = engine.getRun(started.runId)!;
    expect(run.status).toBe('paused');
    expect(run.pauseKind).toBe('user');
    expect(run.entries.map((entry) => entry.status)).toEqual(['completed']);
    expect(afterRuns).toBe(0);

    await engine.resume(started.runId);
    await engine.settled(started.runId);
    run = engine.getRun(started.runId)!;
    expect(run.status).toBe('completed');
    expect(run.result).toBe('conv-1');
    expect(agents.requests).toHaveLength(1);
    expect(afterRuns).toBe(1);
    await engine.dispose();
  });

  it('cancels a run and stops its active agent turn', async () => {
    const agents = fakeAgents({ hold: true });
    const definition = O.workflow('cancellable', { version: 1 }, async () => {
      await O.agent('work', { task: 't1', provider: 'codex', brief: 'Work' });
      return 'done';
    });
    const engine = makeEngine([definition], { agents: agents.executor });
    await engine.start();
    const started = await engine.startRun('cancellable', null);
    if (!started.ok) throw new Error(started.error);
    await vi_waitFor(() => agents.gates.length === 1);
    expect(await engine.cancel(started.runId, 'not needed')).toEqual({ ok: true });
    const run = engine.getRun(started.runId)!;
    expect(run.status).toBe('cancelled');
    expect(run.reason).toBe('not needed');
    expect(run.entries[0]!.status).toBe('cancelled');
    expect(agents.requests[0]!.signal.aborted).toBe(true);
    expect(await engine.resume(started.runId)).toMatchObject({ ok: false });
    await engine.dispose();
  });

  it('pauses for a person when an agent gives up, without auto-resume', async () => {
    const agents = fakeAgents({ hold: true });
    const definition = O.workflow('gives-up', { version: 1 }, async () => {
      await O.agent('fix', { task: 't1', provider: 'claude', brief: 'Fix' });
    });
    const engine = makeEngine([definition], { agents: agents.executor });
    await engine.start();
    const started = await engine.startRun('gives-up', null);
    if (!started.ok) throw new Error(started.error);
    await vi_waitFor(() => agents.gates.length === 1);
    agents.gates[0]!.release({
      status: 'failed',
      message: 'gave up',
      started: true,
      retryable: false,
    } as never);
    await engine.settled(started.runId);
    const run = engine.getRun(started.runId)!;
    expect(run.status).toBe('paused');
    expect(run.pauseKind).toBe('agent');
    expect(run.nextResumeAt).toBeNull();
    await engine.dispose();
  });

  it('asks the agent to correct a result that does not fit returns', async () => {
    const agents = fakeAgents({
      reports: ['I found 2 things.', 'Here:\n```json\n{"count": 2}\n```'],
    });
    const definition = O.workflow('typed', { version: 1 }, async () => {
      const result = (await O.agent('count', {
        task: 't1',
        provider: 'claude',
        brief: 'Count things',
        returns: O.z.object({ count: O.z.number() }),
      })) as { value: { count: number } };
      return result.value.count;
    });
    const engine = makeEngine([definition], { agents: agents.executor });
    await engine.start();
    const started = await engine.startRun('typed', null);
    if (!started.ok) throw new Error(started.error);
    await engine.settled(started.runId);
    expect(engine.getRun(started.runId)!.result).toBe(2);
    expect(agents.followUps).toHaveLength(1);
    expect(agents.requests[0]!.brief).toContain('```json');
    await engine.dispose();
  });

  it('returns failures as data from step.try and validates the payload', async () => {
    const definition = O.workflow(
      'tries',
      { version: 1, payload: O.z.object({ n: O.z.number() }) },
      async () => {
        const result = (await O.step.try('boom', () => {
          throw new Error('kaboom');
        })) as { outcome: string; reason?: string };
        return result;
      }
    );
    const engine = makeEngine([definition]);
    await engine.start();
    expect(await engine.startRun('tries', { n: 'x' })).toMatchObject({ ok: false });
    const started = await engine.startRun('tries', { n: 1 });
    if (!started.ok) throw new Error(started.error);
    await engine.settled(started.runId);
    expect(engine.getRun(started.runId)!.result).toEqual({ outcome: 'failed', reason: 'kaboom' });
    await engine.dispose();
  });

  it('pauses on duplicate primitive names and on a missing version', async () => {
    const definition = O.workflow('dupes', { version: 1 }, async () => {
      await O.step('same', () => 1);
      await O.step('same', () => 2);
    });
    const engine = makeEngine([definition]);
    await engine.start();
    const started = await engine.startRun('dupes', null);
    if (!started.ok) throw new Error(started.error);
    await engine.settled(started.runId);
    const run = engine.getRun(started.runId)!;
    expect(run.status).toBe('paused');
    expect(run.pauseKind).toBe('body');
    expect(run.error).toContain('"same"');

    engine.setDefinitions([]);
    await engine.resume(started.runId);
    await engine.settled(started.runId);
    expect(engine.getRun(started.runId)!.pauseKind).toBe('retired');
    await engine.dispose();
  });
});

describe('extractJsonResult', () => {
  it('reads the last fenced block or the whole reply', () => {
    expect(extractJsonResult('a\n```json\n{"a":1}\n```\nb\n```json\n[2]\n```')).toEqual({
      ok: true,
      value: [2],
    });
    expect(extractJsonResult('{"x":true}')).toEqual({ ok: true, value: { x: true } });
    expect(extractJsonResult('no json')).toEqual({ ok: false });
  });
});

async function vi_waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
