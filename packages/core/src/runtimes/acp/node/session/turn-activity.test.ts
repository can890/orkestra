import { noopLogger } from '@orkestra/shared/logger';
import { describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent } from '#runtimes/acp/node/acp-test-support';
import { ACTIVITY_PUBLISH_INTERVAL_MS, SessionCell } from './cell';

function makeCell() {
  let now = 1_000_000;
  const onSessionStateChanged = vi.fn();
  const agent = new FakeAcpAgent();
  let finishTurn: (value: { stopReason: 'end_turn' }) => void = () => {};
  agent.prompt = vi.fn(
    () =>
      new Promise<{ stopReason: 'end_turn' }>((resolve) => {
        finishTurn = resolve;
      })
  );
  const cell = new SessionCell({
    conversationId: 'conv-activity',
    providerId: 'antigravity',
    acpSessionId: 'session-activity',
    agent,
    resolveAttachment: vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png' }),
    logger: noopLogger,
    callbacks: { onSessionStateChanged },
    now: () => now,
  });
  cell.applySessionReady();
  return {
    cell,
    onSessionStateChanged,
    advance: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
    async finish() {
      await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalled());
      finishTurn({ stopReason: 'end_turn' });
      await vi.waitFor(() => expect(cell.sessionState.lifecycle).toBe('ready'));
    },
  };
}

describe('SessionCell turn activity', () => {
  it('reports when the running turn started and when the provider last sent anything', async () => {
    const h = makeCell();
    expect(h.cell.sessionState.activity).toBeUndefined();

    const turn = h.cell.prompt({ text: 'kareleri üret' });
    const startedAt = h.now;
    expect(h.cell.sessionState.lifecycle).toBe('working');
    expect(h.cell.sessionState.activity).toEqual({
      turnStartedAt: startedAt,
      lastActivityAt: startedAt,
    });

    h.advance(60_000);
    h.cell.push({ kind: 'message', role: 'assistant', messageId: 'a1', text: 'bekliyorum' });
    expect(h.cell.sessionState.activity).toEqual({
      turnStartedAt: startedAt,
      lastActivityAt: startedAt + 60_000,
    });

    // Silence: the timestamp stays put, so a client can tell how long the turn has been quiet.
    h.advance(30 * 60_000);
    expect(h.cell.sessionState.activity?.lastActivityAt).toBe(startedAt + 60_000);

    await h.finish();
    await turn;
    expect(h.cell.sessionState.activity).toBeUndefined();
  });

  it('republishes a newer activity time at a bounded rate, not on every chunk', () => {
    const h = makeCell();
    void h.cell.prompt({ text: 'uzun iş' });
    h.onSessionStateChanged.mockClear();

    for (let i = 0; i < 50; i += 1) {
      h.advance(100);
      h.cell.push({ kind: 'message', role: 'assistant', messageId: 'a1', text: 'x' });
    }
    expect(h.onSessionStateChanged).not.toHaveBeenCalled();

    h.advance(ACTIVITY_PUBLISH_INTERVAL_MS);
    h.cell.push({ kind: 'message', role: 'assistant', messageId: 'a1', text: 'y' });
    expect(h.onSessionStateChanged).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh turn clock for the next turn', async () => {
    const h = makeCell();
    const first = h.cell.prompt({ text: 'bir' });
    await h.finish();
    await first;
    h.advance(10 * 60_000);
    void h.cell.prompt({ text: 'iki' });
    expect(h.cell.sessionState.activity).toEqual({
      turnStartedAt: h.now,
      lastActivityAt: h.now,
    });
  });
});

describe('SessionCell background-task liveness', () => {
  const backgroundRow = (status: 'in_progress' | 'completed' | 'failed') => ({
    kind: 'tool_update' as const,
    toolCallId: 'agy-2',
    parentToolCallId: null,
    toolKind: 'execute',
    status,
    backgroundTask: true as const,
  });

  it('reports running background tasks until the provider closes them', async () => {
    const h = makeCell();
    const turn = h.cell.prompt({ text: 'videoları üret' });
    h.cell.push({
      kind: 'tool_call',
      toolCallId: 'agy-2',
      title: 'run_command',
      toolKind: 'other',
      status: 'in_progress',
      parentToolCallId: null,
      diffs: [],
      locations: [],
    });
    expect(h.cell.sessionState.activity?.backgroundTasks).toBeUndefined();

    h.onSessionStateChanged.mockClear();
    h.cell.push(backgroundRow('in_progress'));
    expect(h.cell.sessionState.activity?.backgroundTasks).toBe(1);
    expect(h.onSessionStateChanged).toHaveBeenCalled();

    // A log line without the flag does not end it; only a terminal status does.
    h.cell.push({
      kind: 'tool_update',
      toolCallId: 'agy-2',
      parentToolCallId: null,
      outputText: 'x',
    });
    expect(h.cell.sessionState.activity?.backgroundTasks).toBe(1);
    h.cell.push(backgroundRow('completed'));
    expect(h.cell.sessionState.activity?.backgroundTasks).toBeUndefined();

    h.cell.push(backgroundRow('in_progress'));
    await h.finish();
    await turn;
    expect(h.cell.sessionState.activity).toBeUndefined();
    void h.cell.prompt({ text: 'sonraki' });
    expect(h.cell.sessionState.activity?.backgroundTasks).toBeUndefined();
  });
});
