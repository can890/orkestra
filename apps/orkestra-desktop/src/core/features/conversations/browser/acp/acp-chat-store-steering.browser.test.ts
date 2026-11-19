import type { SessionState } from '@orkestra/core/runtimes/acp/api/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as agentsClientModule from '@core/features/agents/api/browser/client';
import { installChatUiRuntime } from '@core/features/conversations/api/browser/chat/chat-ui-runtime';
import type * as projectSelectorsModule from '@core/features/projects/api/browser/stores/project-selectors';
import { AcpChatStore } from './acp-chat-store';
import { AcpLiveSession } from './acp-live-session';

vi.mock('@core/features/conversations/api/browser/chat/shared-chat-context', () => ({
  getSharedChatContext: () => ({}),
}));

vi.mock('@core/primitives/mementos/browser', () => ({
  getMementoClient: () => ({
    reportError: vi.fn(),
    subject: () => ({
      ready: Promise.resolve(),
      release: vi.fn(async () => {}),
      handle: () => ({
        value: { version: '1', text: '', attachments: [] },
        autoPersist: vi.fn(),
      }),
    }),
  }),
}));

vi.mock('@core/features/conversations/browser/provider-preferences', () => ({
  updateProviderPreference: vi.fn(async () => {}),
}));

vi.mock('@core/features/conversations/api/browser/stores/conversation-registry', () => ({
  conversationRegistry: {
    get: () => ({
      conversations: {
        get: () => ({ data: { providerId: 'claude', sessionId: 'session-1' } }),
      },
    }),
  },
}));

vi.mock('@core/features/agents/api/browser/client', async (importOriginal) => ({
  ...(await importOriginal<typeof agentsClientModule>()),
  getAgentsClient: async () => ({ listMetadata: vi.fn(async () => []) }),
}));

vi.mock('@core/features/projects/api/browser/stores/project-selectors', async (importOriginal) => ({
  ...(await importOriginal<typeof projectSelectorsModule>()),
  getProjectSshConnectionId: () => undefined,
}));

class FakeRemote<T> {
  constructor(private value: T) {}
  current(): T {
    return this.value;
  }
  set(value: T): void {
    this.value = value;
  }
  onChange(): () => void {
    return () => {};
  }
}

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    lifecycle: 'working',
    activeTurnId: 'turn-1',
    pendingPermissions: [],
    lastStopReason: null,
    lastTurnErrored: false,
    queuedPrompts: [],
    agentTurnActive: false,
    backgroundAgentCount: 0,
    isGenerating: true,
    canSubmit: false,
    canCancel: true,
    supportsSteering: true,
    ...overrides,
  };
}

async function bootstrapStore(initial: SessionState) {
  const sessionState = new FakeRemote(initial);
  const sendPrompt = vi.fn(async (..._args: unknown[]) => ({
    success: true as const,
    data: { queued: false },
  }));
  const deleteQueuedPrompt = vi.fn(async () => ({ success: true as const, data: undefined }));
  const changeQueuePromptOrder = vi.fn(async () => ({ success: true as const, data: undefined }));
  const cancelTurn = vi.fn(async () => ({ success: true as const, data: undefined }));
  const setPendingPrompt = vi.fn();
  installChatUiRuntime({
    createChatContext: () => ({}) as never,
    createChatState: () =>
      ({
        session: { state: { pendingPrompt: null }, setPendingPrompt },
        transcript: {
          state: { displayTurns: [], activeTurnSnapshot: null },
          needsHistory: false,
          applyPage: () => true,
        },
        scroll: { set: vi.fn() },
        dispose: vi.fn(),
      }) as never,
    createChatView: vi.fn() as never,
    connectSession: (() => () => {}) as never,
    pinTopMode: vi.fn() as never,
  });
  const session = {
    sessionState,
    config: new FakeRemote({ availableCommands: [] }),
    usage: new FakeRemote(null),
    plan: new FakeRemote(null),
    activeTurn: new FakeRemote(null),
    terminals: new FakeRemote([]),
    mcpServers: new FakeRemote([]),
    loadHistory: vi.fn(async () => ({ success: true, data: { turns: [], nextCursor: null } })),
    terminalOutput: vi.fn(),
    sendPrompt,
    deleteQueuedPrompt,
    changeQueuePromptOrder,
    cancelTurn,
    usable: true,
    dispose: vi.fn(),
  } as unknown as AcpLiveSession;
  vi.spyOn(AcpLiveSession, 'create').mockResolvedValueOnce(session);
  const store = new AcpChatStore('conversation-steer', 'project-1', 'task-1');
  store.bootstrap();
  await vi.waitFor(() => expect(store.historyLoading).toBe(false));
  return {
    store,
    sessionState,
    sendPrompt,
    deleteQueuedPrompt,
    changeQueuePromptOrder,
    cancelTurn,
    setPendingPrompt,
  };
}

const queued = (id: string, text: string) => ({ id, text, createdAt: 1, updatedAt: 1 });

describe('AcpChatStore steering', () => {
  beforeAll(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('steers a message sent during a steerable turn, without an optimistic row', async () => {
    const h = await bootstrapStore(state());
    expect(h.store.affordances.canSteer).toBe(true);

    h.store.submitPrompt('son durum ne?');

    await vi.waitFor(() => expect(h.sendPrompt).toHaveBeenCalledOnce());
    expect(h.sendPrompt).toHaveBeenCalledWith(
      { text: 'son durum ne?' },
      'steer',
      expect.any(String)
    );
    expect(h.setPendingPrompt).not.toHaveBeenCalled();
    h.store.dispose();
  });

  it('keeps the default placement for agents that cannot be steered', async () => {
    const h = await bootstrapStore(state({ supportsSteering: undefined }));
    expect(h.store.affordances.canSteer).toBe(false);

    h.store.submitPrompt('sonra');

    await vi.waitFor(() => expect(h.sendPrompt).toHaveBeenCalledOnce());
    expect(h.sendPrompt).toHaveBeenCalledWith({ text: 'sonra' }, undefined, expect.any(String));
    h.store.dispose();
  });

  it("queues with placement 'queue' when asked, even though steering is available", async () => {
    const h = await bootstrapStore(state());

    h.store.submitPrompt('sonra bak', [], undefined, { queue: true });

    await vi.waitFor(() => expect(h.sendPrompt).toHaveBeenCalledOnce());
    expect(h.sendPrompt).toHaveBeenCalledWith({ text: 'sonra bak' }, 'queue', expect.any(String));
    h.store.dispose();
  });

  it('only steers a foreground working turn', async () => {
    const idle = await bootstrapStore(
      state({ lifecycle: 'ready', isGenerating: false, canSubmit: true })
    );
    expect(idle.store.affordances.canSteer).toBe(false);
    idle.store.dispose();

    const background = await bootstrapStore(state({ lifecycle: 'ready', backgroundAgentCount: 1 }));
    expect(background.store.affordances.canSteer).toBe(false);
    background.store.dispose();

    const cancelling = await bootstrapStore(state({ lifecycle: 'cancelling' }));
    expect(cancelling.store.affordances.canSteer).toBe(false);
    cancelling.store.dispose();
  });

  it('send-now steers a queued prompt without reordering or cancelling the turn', async () => {
    const h = await bootstrapStore(state({ queuedPrompts: [queued('q1', 'sonra bak')] }));

    h.store.sendQueuedPromptNow('q1');

    await vi.waitFor(() => expect(h.sendPrompt).toHaveBeenCalledOnce());
    expect(h.deleteQueuedPrompt).toHaveBeenCalledWith('q1');
    expect(h.sendPrompt).toHaveBeenCalledWith({ text: 'sonra bak' }, 'steer', 'q1');
    expect(h.changeQueuePromptOrder).not.toHaveBeenCalled();
    expect(h.cancelTurn).not.toHaveBeenCalled();
    h.store.dispose();
  });

  it('send-now puts the prompt back in the queue when steering fails', async () => {
    const h = await bootstrapStore(state({ queuedPrompts: [queued('q1', 'sonra bak')] }));
    h.sendPrompt.mockResolvedValueOnce({ success: false, error: 'boom' } as never);

    h.store.sendQueuedPromptNow('q1');

    await vi.waitFor(() => expect(h.sendPrompt).toHaveBeenCalledTimes(2));
    expect(h.sendPrompt).toHaveBeenLastCalledWith({ text: 'sonra bak' }, 'queue', 'q1');
    h.store.dispose();
  });

  it('send-now keeps cancel-and-send for agents without steering', async () => {
    const h = await bootstrapStore(
      state({ supportsSteering: undefined, queuedPrompts: [queued('q1', 'sonra bak')] })
    );

    h.store.sendQueuedPromptNow('q1');

    await vi.waitFor(() => expect(h.cancelTurn).toHaveBeenCalledOnce());
    expect(h.changeQueuePromptOrder).toHaveBeenCalledWith(['q1']);
    expect(h.deleteQueuedPrompt).not.toHaveBeenCalled();
    expect(h.sendPrompt).not.toHaveBeenCalled();
    h.store.dispose();
  });

  describe('side answer decision matrix', () => {
    const side = (overrides: Partial<SessionState> = {}) =>
      state({ supportsSteering: undefined, supportsSideAnswer: true, ...overrides });

    it('asks on the side when the agent cannot be steered but the runtime can answer', async () => {
      const h = await bootstrapStore(side());
      expect(h.store.affordances.canSideAnswer).toBe(true);
      expect(h.store.affordances.canSteer).toBe(false);

      h.store.submitPrompt('son durum ne?');

      await vi.waitFor(() => expect(h.sendPrompt).toHaveBeenCalledOnce());
      expect(h.sendPrompt).toHaveBeenCalledWith(
        { text: 'son durum ne?' },
        'side',
        expect.any(String)
      );
      expect(h.setPendingPrompt).not.toHaveBeenCalled();
      h.store.dispose();
    });

    it('prefers steering over a side answer when both are advertised', async () => {
      const h = await bootstrapStore(side({ supportsSteering: true }));
      expect(h.store.affordances.canSideAnswer).toBe(false);
      h.store.submitPrompt('x');
      await vi.waitFor(() => expect(h.sendPrompt).toHaveBeenCalledOnce());
      expect(h.sendPrompt).toHaveBeenCalledWith({ text: 'x' }, 'steer', expect.any(String));
      h.store.dispose();
    });

    it("queues with placement 'queue' on Alt+Enter, and keeps the default for old runtimes", async () => {
      const queued = await bootstrapStore(side());
      queued.store.submitPrompt('sonra', [], undefined, { queue: true });
      await vi.waitFor(() => expect(queued.sendPrompt).toHaveBeenCalledOnce());
      expect(queued.sendPrompt).toHaveBeenCalledWith(
        { text: 'sonra' },
        'queue',
        expect.any(String)
      );
      queued.store.dispose();

      const old = await bootstrapStore(side({ supportsSideAnswer: undefined }));
      expect(old.store.affordances.canSideAnswer).toBe(false);
      old.store.submitPrompt('sonra');
      await vi.waitFor(() => expect(old.sendPrompt).toHaveBeenCalledOnce());
      expect(old.sendPrompt).toHaveBeenCalledWith({ text: 'sonra' }, undefined, expect.any(String));
      old.store.dispose();
    });

    it('does not ask on the side with attachments, when idle, cancelling or background-only', async () => {
      const withFile = await bootstrapStore(side());
      withFile.store.submitPrompt('bak', [
        { ref: { type: 'attachment', id: 'a', mimeType: 'image/png' } },
      ]);
      await vi.waitFor(() => expect(withFile.sendPrompt).toHaveBeenCalledOnce());
      expect(withFile.sendPrompt.mock.calls[0][1]).toBeUndefined();
      withFile.store.dispose();

      for (const overrides of [
        { lifecycle: 'ready' as const, isGenerating: false, canSubmit: true },
        { lifecycle: 'cancelling' as const },
        { lifecycle: 'ready' as const, backgroundAgentCount: 1 },
      ]) {
        const h = await bootstrapStore(side(overrides));
        expect(h.store.affordances.canSideAnswer).toBe(false);
        h.store.dispose();
      }
    });

    it('Ajana ilet queues the original question for the main agent', async () => {
      const h = await bootstrapStore(side());
      h.store.forwardSideQuestion('bunu da düzelt');
      await vi.waitFor(() => expect(h.sendPrompt).toHaveBeenCalledOnce());
      expect(h.sendPrompt).toHaveBeenCalledWith(
        { text: 'bunu da düzelt' },
        'queue',
        expect.any(String)
      );
      h.store.forwardSideQuestion('   ');
      expect(h.sendPrompt).toHaveBeenCalledOnce();
      h.store.dispose();
    });

    it('send-now keeps cancel-and-send with side answers (no steering)', async () => {
      const h = await bootstrapStore(side({ queuedPrompts: [queued('q1', 'sonra bak')] }));
      h.store.sendQueuedPromptNow('q1');
      await vi.waitFor(() => expect(h.cancelTurn).toHaveBeenCalledOnce());
      expect(h.changeQueuePromptOrder).toHaveBeenCalledWith(['q1']);
      expect(h.deleteQueuedPrompt).not.toHaveBeenCalled();
      h.store.dispose();
    });
  });
});
