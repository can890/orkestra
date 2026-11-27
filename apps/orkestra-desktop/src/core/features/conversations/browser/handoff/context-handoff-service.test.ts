import { describe, expect, it, vi } from 'vitest';
import {
  BRIEF_REQUEST_MARKER,
  isContextHandoffSystemPrompt,
  type HandoffTurnWithOutcome,
  type TranscriptLocation,
} from '@core/features/conversations/api/context-handoff-package';
import { isHandoffLineageTitle } from '@core/features/conversations/api/handoff-title';
import type { CreateConversationParams } from '@core/primitives/conversations/api';
import {
  ContextHandoffCoordinator,
  type BriefRequestResult,
  type ContextHandoffEnvironment,
  type ContextHandoffSourcePort,
} from './context-handoff-service';
import type { HandoffRecord } from './handoff-store';

const BRIEF = `1. Amaç: ödeme modülünü taşı.\n2. "Testleri asla silme."\n${'durum '.repeat(80)}`;

function history(extra: HandoffTurnWithOutcome[] = []): HandoffTurnWithOutcome[] {
  return [
    {
      id: 't1',
      seq: 1,
      items: [
        {
          id: 'u1',
          kind: 'message',
          role: 'user',
          text: 'Ödeme modülünü taşı. Testleri asla silme.',
        },
        { id: 'a1', kind: 'message', role: 'assistant', text: 'Başladım, adaptörü yazıyorum.' },
      ],
      outcome: { kind: 'done' },
    },
    ...extra,
  ];
}

function briefTurn(
  promptId: string,
  text: string,
  outcome = { kind: 'done' }
): HandoffTurnWithOutcome {
  return {
    id: 't-brief',
    seq: 2,
    items: [
      { id: 'ub', kind: 'message', role: 'user', text: `${BRIEF_REQUEST_MARKER} ...`, promptId },
      { id: 'ab', kind: 'message', role: 'assistant', text },
    ],
    outcome,
  };
}

type FakeSourceOptions = {
  working?: boolean;
  usable?: boolean;
  queued?: string[];
  brief?: (signal: AbortSignal) => Promise<BriefRequestResult>;
  turnsAfterBrief?: HandoffTurnWithOutcome[];
};

function createFakeSource(options: FakeSourceOptions = {}) {
  let working = options.working ?? false;
  let queue = [...(options.queued ?? [])];
  let idleResolvers: Array<(value: 'idle' | 'aborted') => void> = [];
  const restored: string[][] = [];
  const requestBrief = vi.fn(
    (_text: string, _timeoutMs: number, signal: AbortSignal): Promise<BriefRequestResult> =>
      options.brief
        ? options.brief(signal)
        : Promise.resolve({ status: 'completed', promptId: 'p-1' })
  );
  let briefSent = false;
  const port: ContextHandoffSourcePort = {
    conversationId: 'src',
    projectId: 'proj',
    taskId: 'task',
    title: () => 'Ödeme taşıma',
    providerId: () => 'claude',
    providerLabel: () => 'Claude',
    isWorking: () => working,
    isUsable: () => options.usable ?? true,
    waitUntilIdle: (signal) =>
      new Promise((resolve) => {
        if (!working) {
          resolve('idle');
          return;
        }
        idleResolvers.push(resolve);
        signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      }),
    takeQueuedPrompts: async () => {
      const taken = queue;
      queue = [];
      return taken;
    },
    restoreQueuedPrompts: (texts) => {
      restored.push([...texts]);
    },
    requestBrief: async (text, timeoutMs, signal) => {
      briefSent = true;
      return requestBrief(text, timeoutMs, signal);
    },
    loadTurns: async () =>
      briefSent ? (options.turnsAfterBrief ?? history([briefTurn('p-1', BRIEF)])) : history(),
    snapshot: () => ({
      draftText: 'yarım kalmış taslak',
      planEntries: [{ content: 'Adaptör testleri', status: 'in_progress' }],
      runningAgents: [{ name: 'araştırmacı', detail: 'API sürümleri' }],
    }),
    conversationSettings: () => ({
      autoApprove: true,
      model: 'opus',
      modeId: 'acceptEdits',
      effort: 'high',
      collaborationMode: 'default',
    }),
  };
  return {
    port,
    requestBrief,
    restored,
    get queue() {
      return queue;
    },
    finishTurn() {
      working = false;
      const resolvers = idleResolvers;
      idleResolvers = [];
      for (const resolve of resolvers) resolve('idle');
    },
  };
}

function createFakeEnvironment(
  options: {
    transcript?: (input: { newConversationId: string }) => Promise<TranscriptLocation>;
    createConversation?: (params: CreateConversationParams & { taskName?: string }) => Promise<void>;
    records?: Map<string, HandoffRecord>;
    separateTask?: boolean;
  } = {}
) {
  const records = options.records ?? new Map<string, HandoffRecord>();
  const created: Array<CreateConversationParams & { taskName?: string }> = [];
  const opened: Array<{
    sourceConversationId: string;
    conversationId: string;
    targetTaskId?: string;
  }> = [];
  const drafts = new Map<string, string>();
  const prunes = { count: 0 };
  let counter = 0;
  let taskCounter = 0;
  const env: ContextHandoffEnvironment = {
    newConversationId: () => `new-${++counter}`,
    ...(options.separateTask ? { newTaskId: () => `task-next-${++taskCounter}` } : {}),
    now: () => 1_700_000_000_000,
    writeTranscript:
      options.transcript ??
      (async ({ newConversationId }) => ({
        kind: 'written',
        path: `/home/u/.orkestra/handoffs/${newConversationId}.md`,
        hostLabel: 'çalıştığın makinede',
        truncated: false,
      })),
    createConversation: async (params) => {
      await options.createConversation?.(params);
      created.push(params);
    },
    openBeside: (input) => opened.push(input),
    setPendingDraft: (id, text) => drafts.set(id, text),
    pruneTranscripts: () => {
      prunes.count += 1;
    },
    handoffStore: {
      get: (id) => records.get(id),
      put: (id, record) => records.set(id, record),
      remove: (id) => records.delete(id),
      findContextSuccessor: (sourceId) =>
        [...records.entries()].find(
          ([, record]) =>
            record.mode === 'context-handoff' && record.sourceConversationId === sourceId
        )?.[0],
    },
  };
  return { env, created, opened, drafts, records, prunes };
}

describe('ContextHandoffCoordinator', () => {
  it('happy path: agent brief → new conversation beside the source → auto-continue with hidden context', async () => {
    const source = createFakeSource({ queued: ['Sonra README güncelle'] });
    const { env, created, opened, drafts, records, prunes } = createFakeEnvironment();
    const coordinator = new ContextHandoffCoordinator();

    const outcome = await coordinator.start(source.port, env);
    // A new dump was written on this host: old dumps there are cleaned up opportunistically.
    expect(prunes.count).toBe(1);

    expect(outcome).toEqual({
      kind: 'moved',
      conversationId: 'new-1',
      contextSource: 'agent-brief',
    });
    expect(source.requestBrief).toHaveBeenCalledTimes(1);
    expect(source.requestBrief.mock.calls[0]?.[0]).toMatch(/^\[Bağlam devri\]/);
    expect(created).toHaveLength(1);
    const params = created[0]!;
    expect(params).toMatchObject({
      id: 'new-1',
      projectId: 'proj',
      taskId: 'task',
      provider: 'claude',
      title: 'Ödeme taşıma (devam)',
      autoApprove: true,
      model: 'opus',
      modeId: 'acceptEdits',
      effort: 'high',
      collaborationMode: 'default',
      type: 'acp',
    });
    const [first, ...rest] = params.initialQueue ?? [];
    expect(first?.text).toContain('kaldığın yerden devam et');
    expect(first?.text).not.toContain('otomatik özet');
    const hidden = first?.hiddenContext ?? '';
    expect(hidden).toContain('## 1. Devir notu');
    expect(hidden).toContain('"Testleri asla silme."');
    expect(hidden).toContain('Ödeme modülünü taşı. Testleri asla silme.');
    expect(hidden).toContain('/home/u/.orkestra/handoffs/new-1.md');
    expect(hidden).toContain('[sürüyor] Adaptör testleri');
    expect(hidden).toContain('araştırmacı');
    expect(hidden).toContain('Sonra README güncelle');
    // Queued prompts follow the continue prompt verbatim, without hidden context.
    expect(rest).toEqual([{ text: 'Sonra README güncelle' }]);
    expect(source.queue).toEqual([]);
    expect(drafts.get('new-1')).toBe('yarım kalmış taslak');
    expect(opened).toEqual([{ sourceConversationId: 'src', conversationId: 'new-1' }]);
    expect(records.get('new-1')).toMatchObject({
      mode: 'context-handoff',
      sourceConversationId: 'src',
      contextDelivered: true,
      contextSource: 'agent-brief',
      transcriptPath: '/home/u/.orkestra/handoffs/new-1.md',
    });
    expect(coordinator.phase('src')).toEqual({
      kind: 'done',
      conversationId: 'new-1',
      contextSource: 'agent-brief',
    });
    expect(source.restored).toEqual([]);
  });

  it('successor title: named after the source, protected from the agent title, numbered on a second move', async () => {
    const { env, created, records } = createFakeEnvironment();
    const coordinator = new ContextHandoffCoordinator();

    const first = createFakeSource();
    await coordinator.start(first.port, env);
    const firstParams = created[0]!;
    expect(firstParams.title).toBe('Ödeme taşıma (devam)');
    // The agent's session title (derived from the automatic first prompt) must not replace it,
    // and that prompt must not name the task either.
    expect(isHandoffLineageTitle(firstParams.title)).toBe(true);
    expect(isContextHandoffSystemPrompt(firstParams.initialQueue?.[0]?.text)).toBe(true);
    expect(isContextHandoffSystemPrompt(first.requestBrief.mock.calls[0]?.[0])).toBe(true);

    // Moving the successor again: "(devam 2)", not "(devam) (devam)".
    const second = createFakeSource();
    const successorPort = {
      ...second.port,
      conversationId: 'new-1',
      title: () => firstParams.title ?? '',
    };
    const outcome = await coordinator.start(successorPort, env);
    expect(outcome).toMatchObject({ kind: 'moved', conversationId: 'new-2' });
    expect(created[1]?.title).toBe('Ödeme taşıma (devam 2)');
    expect(records.get('new-2')).toMatchObject({
      sourceConversationId: 'new-1',
      sourceTitle: 'Ödeme taşıma (devam)',
    });
    // The second package still points at the first transcript.
    expect(created[1]?.initialQueue?.[0]?.hiddenContext).toContain(
      '/home/u/.orkestra/handoffs/new-1.md'
    );
  });

  it('source mid-turn: waits for the turn to end without cancelling it, then asks for the brief', async () => {
    const source = createFakeSource({ working: true });
    const { env, created } = createFakeEnvironment();
    const coordinator = new ContextHandoffCoordinator();

    const pending = coordinator.start(source.port, env);
    await Promise.resolve();
    await Promise.resolve();
    expect(coordinator.phase('src')).toEqual({ kind: 'waiting-turn' });
    expect(coordinator.isInFlight('src')).toBe(true);
    expect(source.requestBrief).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);

    source.finishTurn();
    const outcome = await pending;
    expect(outcome.kind).toBe('moved');
    expect(source.requestBrief).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  it('cancelling while waiting creates nothing and gives the taken queue back', async () => {
    const source = createFakeSource({ working: true, queued: ['sıradaki'] });
    const { env, created } = createFakeEnvironment();
    const coordinator = new ContextHandoffCoordinator();

    const pending = coordinator.start(source.port, env);
    await Promise.resolve();
    await Promise.resolve();
    expect(coordinator.cancel('src')).toBe(true);
    expect(await pending).toEqual({ kind: 'cancelled' });
    expect(created).toHaveLength(0);
    expect(source.restored).toEqual([['sıradaki']]);
    expect(coordinator.phase('src')).toBeUndefined();
  });

  it('brief failure → falls back to the heuristic summary and says so in the new conversation', async () => {
    const source = createFakeSource({
      turnsAfterBrief: history([
        briefTurn('p-1', '', { kind: 'error', message: 'prompt is too long' } as never),
      ]),
    });
    const { env, created, records } = createFakeEnvironment();
    const outcome = await new ContextHandoffCoordinator().start(source.port, env);

    expect(outcome).toMatchObject({ kind: 'moved', contextSource: 'heuristic' });
    if (outcome.kind === 'moved') expect(outcome.fallbackReason).toContain('prompt is too long');
    const first = created[0]?.initialQueue?.[0];
    expect(first?.text).toContain('otomatik özet');
    // The visible first message says why, as the feature documentation promises.
    expect(first?.text).toContain('prompt is too long');
    expect(first?.hiddenContext).toContain('## 1. Otomatik özet');
    expect(first?.hiddenContext).toContain('Önceki ajan devir notu yazamadı');
    expect(first?.hiddenContext).toContain('[Devir özeti]');
    expect(records.get('new-1')?.contextSource).toBe('heuristic');
  });

  it('brief timeout and unusable source also fall back instead of blocking', async () => {
    const timedOut = createFakeSource({
      brief: async () => ({ status: 'timeout', promptId: 'p-1' }),
    });
    const first = await new ContextHandoffCoordinator().start(
      timedOut.port,
      createFakeEnvironment().env
    );
    expect(first).toMatchObject({ kind: 'moved', contextSource: 'heuristic' });

    const offline = createFakeSource({ usable: false });
    const second = await new ContextHandoffCoordinator().start(
      offline.port,
      createFakeEnvironment().env
    );
    expect(second).toMatchObject({ kind: 'moved', contextSource: 'heuristic' });
    expect(offline.requestBrief).not.toHaveBeenCalled();
  });

  it('double trigger: a second click during the move returns the same job and creates one conversation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = createFakeSource({
      brief: async () => {
        await gate;
        return { status: 'completed', promptId: 'p-1' };
      },
    });
    const { env, created } = createFakeEnvironment();
    const coordinator = new ContextHandoffCoordinator();

    const one = coordinator.start(source.port, env);
    const two = coordinator.start(source.port, env);
    expect(two).toBe(one);
    release();
    await one;
    expect(created).toHaveLength(1);
    expect(source.requestBrief).toHaveBeenCalledTimes(1);

    // After the move, another trigger opens nothing new.
    const again = await coordinator.start(source.port, env);
    expect(again).toEqual({ kind: 'already-moved', conversationId: 'new-1' });
    expect(created).toHaveLength(1);
  });

  it('a failed create removes the lineage record and gives the queue back', async () => {
    const source = createFakeSource({ queued: ['sıradaki'] });
    const { env, records, prunes } = createFakeEnvironment({
      createConversation: async () => {
        throw new Error('host offline');
      },
    });
    const outcome = await new ContextHandoffCoordinator().start(source.port, env);
    expect(outcome).toEqual({ kind: 'failed', message: 'host offline' });
    expect(prunes.count).toBe(0);
    expect(records.size).toBe(0);
    expect(source.restored).toEqual([['sıradaki']]);
  });

  it('still moves when the transcript cannot be written, and tells the new agent', async () => {
    const source = createFakeSource();
    const { env, created, records, prunes } = createFakeEnvironment({
      transcript: async () => {
        throw new Error('disk full');
      },
    });
    await new ContextHandoffCoordinator().start(source.port, env);
    expect(prunes.count).toBe(0);
    expect(created[0]?.initialQueue?.[0]?.hiddenContext).toContain(
      'dosyaya yazılamadı (disk full)'
    );
    expect(records.get('new-1')?.transcriptPath).toBeUndefined();
  });

  it('points at the previous transcript when the source was itself a hand-over', async () => {
    const records = new Map<string, HandoffRecord>([
      [
        'src',
        {
          version: 1,
          mode: 'context-handoff',
          sourceConversationId: 'older',
          sourceTitle: 'Eski',
          context: '',
          createdAt: 1,
          transcriptPath: '/home/u/.orkestra/handoffs/src.md',
        },
      ],
    ]);
    const { env, created } = createFakeEnvironment({ records });
    await new ContextHandoffCoordinator().start(createFakeSource().port, env);
    expect(created[0]?.initialQueue?.[0]?.hiddenContext).toContain(
      '/home/u/.orkestra/handoffs/src.md'
    );
  });

  it('creates a separate sidebar task and passes targetTaskId to openBeside and already-moved', async () => {
    const source = createFakeSource();
    source.port.taskTitle = () => 'Orkestra Uygulmasında';
    const { env, created, opened, records } = createFakeEnvironment({ separateTask: true });
    const coordinator = new ContextHandoffCoordinator();

    const outcome = await coordinator.start(source.port, env);
    expect(outcome).toEqual({
      kind: 'moved',
      conversationId: 'new-1',
      targetTaskId: 'task-next-1',
      contextSource: 'agent-brief',
    });
    expect(created[0]).toMatchObject({
      id: 'new-1',
      taskId: 'task-next-1',
      taskName: 'Orkestra Uygulmasında (devam)',
      title: 'Ödeme taşıma (devam)',
    });
    expect(records.get('new-1')?.targetTaskId).toBe('task-next-1');
    expect(opened).toEqual([
      {
        sourceConversationId: 'src',
        conversationId: 'new-1',
        targetTaskId: 'task-next-1',
      },
    ]);

    const again = await coordinator.start(source.port, env);
    expect(again).toEqual({
      kind: 'already-moved',
      conversationId: 'new-1',
      targetTaskId: 'task-next-1',
    });
  });
});
