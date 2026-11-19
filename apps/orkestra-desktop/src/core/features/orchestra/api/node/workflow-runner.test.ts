import { describe, expect, it } from 'vitest';
import {
  createWorkflowRun,
  WorkflowRunner,
  type WorkerOutcome,
  type WorkflowWorkerPort,
} from '@core/features/orchestra/api/node/workflow-runner';
import type { WorkflowDefinition, WorkflowRun } from '@core/features/orchestra/api/workflow';

const step = (id: string, dependsOn: string[] = [], prompt = `${id} işi`) => ({
  id,
  agent: 'claude',
  prompt,
  dependsOn,
});

type Controls = { resolve(outcome: WorkerOutcome): void; stepId: string; text: string };

/** Her işçinin sonucunu testin elle verdiği sahte port. */
function fakePort(auto?: (stepId: string, text: string) => WorkerOutcome | 'hang') {
  const events: string[] = [];
  const workers = new Map<string, Controls & { promise: Promise<WorkerOutcome> }>();
  const cancelled: string[] = [];
  let active = 0;
  let peak = 0;
  const stepOf = new Map<string, string>();
  const port: WorkflowWorkerPort = {
    async startWorker({ stepId }) {
      const workerId = `w-${stepId}`;
      stepOf.set(workerId, stepId);
      events.push(`start:${stepId}`);
      active += 1;
      peak = Math.max(peak, active);
      return { workerId };
    },
    async sendPrompt({ workerId, text }) {
      const stepId = stepOf.get(workerId)!;
      let resolve!: (outcome: WorkerOutcome) => void;
      const promise = new Promise<WorkerOutcome>((r) => (resolve = r));
      workers.set(workerId, { resolve, stepId, text, promise });
      const outcome = auto?.(stepId, text);
      if (outcome && outcome !== 'hang') queueMicrotask(() => resolve(outcome));
      return { promptId: `p-${stepId}` };
    },
    async waitForReport({ workerId, onPhase }) {
      onPhase('running');
      const outcome = await workers.get(workerId)!.promise;
      active -= 1;
      events.push(`end:${stepOf.get(workerId)}`);
      return outcome;
    },
    async cancel(workerId) {
      cancelled.push(workerId);
      active -= 1;
    },
  };
  return {
    port,
    events,
    cancelled,
    workers,
    peak: () => peak,
  };
}

const ok = (report: string): WorkerOutcome => ({ status: 'done', report, errorMessage: null });
const fail = (message: string): WorkerOutcome => ({
  status: 'error',
  report: null,
  errorMessage: message,
});

function makeRun(
  workflow: WorkflowDefinition,
  overrides: Partial<{ maxConcurrency: number; input: string }> = {}
): WorkflowRun {
  return createWorkflowRun({
    id: 'run-1',
    workflow,
    projectId: 'p',
    taskId: 't',
    input: overrides.input ?? 'kullanıcı girişi',
    autoApprove: false,
    maxConcurrency: overrides.maxConcurrency ?? 1,
    now: 1,
  });
}

const statuses = (run: WorkflowRun) => Object.fromEntries(run.steps.map((s) => [s.id, s.status]));
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('WorkflowRunner', () => {
  it('bağımlılık sırasına göre çalıştırır ve raporu sonraki isteme çerçeveleyerek aktarır', async () => {
    const fake = fakePort((stepId) => ok(`${stepId}-raporu`));
    const workflow: WorkflowDefinition = {
      id: 'wf',
      name: 'Sıralı',
      steps: [
        step('b', ['a'], 'Girdi: {{input}} / {{steps.a.report}}'),
        step('a'),
        step('c', ['b']),
      ],
    };
    const run = makeRun(workflow);
    await new WorkflowRunner({ port: fake.port }).execute(
      workflow,
      run,
      new AbortController().signal
    );
    expect(fake.events.filter((e) => e.startsWith('start'))).toEqual([
      'start:a',
      'start:b',
      'start:c',
    ]);
    expect(run.status).toBe('completed');
    expect(statuses(run)).toEqual({ a: 'completed', b: 'completed', c: 'completed' });
    const promptOfB = fake.workers.get('w-b')!.text;
    expect(promptOfB).toContain('Girdi: kullanıcı girişi');
    expect(promptOfB).toContain('<previous-step-output step="a">\na-raporu');
    expect(run.steps.find((s) => s.id === 'a')!.report).toBe('a-raporu');
  });

  it('bağımsız adımları paralel çalıştırır ama eşzamanlılık sınırına uyar', async () => {
    const fake = fakePort();
    const workflow: WorkflowDefinition = {
      id: 'wf',
      name: 'Paralel',
      steps: [step('a'), step('b'), step('c'), step('d', ['a', 'b', 'c'])],
    };
    const run = makeRun(workflow, { maxConcurrency: 2 });
    const done = new WorkflowRunner({ port: fake.port }).execute(
      workflow,
      run,
      new AbortController().signal
    );
    await tick();
    expect(statuses(run)).toMatchObject({ a: 'running', b: 'running', c: 'pending', d: 'pending' });
    fake.workers.get('w-a')!.resolve(ok('A'));
    await tick();
    expect(statuses(run)).toMatchObject({
      a: 'completed',
      b: 'running',
      c: 'running',
      d: 'pending',
    });
    fake.workers.get('w-b')!.resolve(ok('B'));
    fake.workers.get('w-c')!.resolve(ok('C'));
    await tick();
    expect(statuses(run).d).toBe('running');
    fake.workers.get('w-d')!.resolve(ok('D'));
    await done;
    expect(fake.peak()).toBe(2);
    expect(run.status).toBe('completed');
  });

  it('varsayılan eşzamanlılık 1 iken adımlar tek tek çalışır', async () => {
    const fake = fakePort((stepId) => ok(stepId));
    const workflow: WorkflowDefinition = {
      id: 'wf',
      name: 'Tek tek',
      steps: [step('a'), step('b'), step('c')],
    };
    await new WorkflowRunner({ port: fake.port }).execute(
      workflow,
      makeRun(workflow),
      new AbortController().signal
    );
    expect(fake.peak()).toBe(1);
  });

  it('başarısız adımın bağımlılarını atlar, bağımsız dalı sürdürür', async () => {
    const fake = fakePort((stepId) => (stepId === 'a' ? fail('patladı') : ok(stepId)));
    const workflow: WorkflowDefinition = {
      id: 'wf',
      name: 'Hata',
      steps: [step('a'), step('b', ['a']), step('c', ['b']), step('x'), step('y', ['x'])],
    };
    const run = makeRun(workflow, { maxConcurrency: 3 });
    await new WorkflowRunner({ port: fake.port }).execute(
      workflow,
      run,
      new AbortController().signal
    );
    expect(statuses(run)).toEqual({
      a: 'failed',
      b: 'skipped',
      c: 'skipped',
      x: 'completed',
      y: 'completed',
    });
    expect(run.steps[0]!.error).toBe('patladı');
    expect(run.steps[1]!.error).toContain('"a"');
    expect(run.status).toBe('failed');
    expect(fake.events).not.toContain('start:b');
  });

  it('başlatılamayan işçiyi başarısız sayar', async () => {
    const fake = fakePort();
    fake.port.startWorker = async () => {
      throw new Error('ajan kurulu değil');
    };
    const workflow: WorkflowDefinition = {
      id: 'wf',
      name: 'x',
      steps: [step('a'), step('b', ['a'])],
    };
    const run = makeRun(workflow);
    await new WorkflowRunner({ port: fake.port }).execute(
      workflow,
      run,
      new AbortController().signal
    );
    expect(statuses(run)).toEqual({ a: 'failed', b: 'skipped' });
    expect(run.steps[0]!.error).toBe('ajan kurulu değil');
  });

  it('iptalde çalışan işçileri iptal eder, bekleyenleri iptal edilmiş işaretler', async () => {
    const fake = fakePort();
    const workflow: WorkflowDefinition = {
      id: 'wf',
      name: 'İptal',
      steps: [step('a'), step('b', ['a']), step('c')],
    };
    const run = makeRun(workflow, { maxConcurrency: 2 });
    const controller = new AbortController();
    const done = new WorkflowRunner({ port: fake.port }).execute(workflow, run, controller.signal);
    await tick();
    controller.abort();
    await done;
    expect(fake.cancelled.sort()).toEqual(['w-a', 'w-c']);
    expect(statuses(run)).toEqual({ a: 'cancelled', b: 'cancelled', c: 'cancelled' });
    expect(run.status).toBe('cancelled');
    expect(run.finishedAt).not.toBeNull();
  });

  it('zaman aşımında adımı başarısız yapar ve işçiyi durdurur', async () => {
    const fake = fakePort();
    const workflow: WorkflowDefinition = {
      id: 'wf',
      name: 'x',
      steps: [step('a'), step('b', ['a'])],
    };
    const run = makeRun(workflow);
    await new WorkflowRunner({ port: fake.port, stepTimeoutMs: 20 }).execute(
      workflow,
      run,
      new AbortController().signal
    );
    expect(statuses(run)).toEqual({ a: 'failed', b: 'skipped' });
    expect(run.steps[0]!.error).toContain('zaman aşımı');
    expect(fake.cancelled).toEqual(['w-a']);
  });

  it('izin beklerken adım durumunu awaiting-permission yapar', async () => {
    const fake = fakePort();
    fake.port.waitForReport = async ({ workerId, onPhase }) => {
      onPhase('awaiting-permission');
      return fake.workers.get(workerId)!.promise;
    };
    const workflow: WorkflowDefinition = { id: 'wf', name: 'x', steps: [step('a')] };
    const run = makeRun(workflow);
    const done = new WorkflowRunner({ port: fake.port }).execute(
      workflow,
      run,
      new AbortController().signal
    );
    await tick();
    expect(statuses(run).a).toBe('awaiting-permission');
    fake.workers.get('w-a')!.resolve(ok('bitti'));
    await done;
    expect(statuses(run).a).toBe('completed');
  });

  it('adım sonucunu raporlayan her durum değişikliğinde onChange çağırır', async () => {
    const fake = fakePort((stepId) => ok(stepId));
    const workflow: WorkflowDefinition = { id: 'wf', name: 'x', steps: [step('a')] };
    const seen: string[] = [];
    const run = makeRun(workflow);
    await new WorkflowRunner({
      port: fake.port,
      onChange: (r) => seen.push(`${r.status}:${r.steps[0]!.status}`),
    }).execute(workflow, run, new AbortController().signal);
    expect(seen).toEqual([
      'running:running',
      'running:running',
      'running:completed',
      'completed:completed',
    ]);
  });

  it('döngülü tanımı çalıştırmayı reddeder', async () => {
    const fake = fakePort();
    const workflow: WorkflowDefinition = {
      id: 'wf',
      name: 'x',
      steps: [step('a', ['b']), step('b', ['a'])],
    };
    await expect(
      new WorkflowRunner({ port: fake.port }).execute(
        workflow,
        makeRun(workflow),
        new AbortController().signal
      )
    ).rejects.toThrow('döngü');
  });
});
