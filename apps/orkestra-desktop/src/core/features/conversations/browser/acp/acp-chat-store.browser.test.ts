import type { LoadHistoryResult, SessionState } from '@orkestra/core/runtimes/acp/api/client';
import { toast } from '@orkestra/ui/react/primitives';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as agentsClientModule from '@core/features/agents/api/browser/client';
import { installChatUiRuntime } from '@core/features/conversations/api/browser/chat/chat-ui-runtime';
import type * as projectSelectorsModule from '@core/features/projects/api/browser/stores/project-selectors';
import type { AgentMetadata } from '@core/primitives/agents/api';
import { AcpChatStore } from './acp-chat-store';
import { AcpLiveSession } from './acp-live-session';

const testState = vi.hoisted(() => ({
  listMetadata: vi.fn(),
  onTurnCommitted: undefined as (() => void) | undefined,
}));

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
  getAgentsClient: async () => ({ listMetadata: testState.listMetadata }),
}));

vi.mock('@core/features/projects/api/browser/stores/project-selectors', async (importOriginal) => ({
  ...(await importOriginal<typeof projectSelectorsModule>()),
  getProjectSshConnectionId: () => undefined,
}));

const claudeMetadata = {
  id: 'claude',
  capabilities: {
    models: {
      kind: 'selectable',
      modelOptions: { 'claude-opus-4-8': { name: 'Claude Opus 4.8' } },
    },
  },
} as unknown as AgentMetadata;

const opusCleared = {
  clearedConfiguration: ['model' as const],
  clearedValues: { model: 'claude-opus-4-8' },
};

describe('AcpChatStore cleared model notice', () => {
  beforeAll(() => {
    installChatUiRuntime({
      createChatContext: () => ({}) as never,
      createChatState: () =>
        ({
          session: { state: { pendingPrompt: null }, setPendingPrompt: vi.fn() },
          transcript: {
            state: { displayTurns: [], activeTurnSnapshot: null },
            needsHistory: false,
            applyPage: () => true,
          },
          scroll: { set: vi.fn() },
          dispose: vi.fn(),
        }) as never,
      createChatView: vi.fn() as never,
      connectSession: ((
        _state: unknown,
        _source: unknown,
        options?: { onTurnCommitted?: () => void }
      ) => {
        testState.onTurnCommitted = options?.onTurnCommitted;
        return () => {};
      }) as never,
      pinTopMode: vi.fn() as never,
    });
  });

  beforeEach(() => {
    testState.listMetadata.mockReset();
    testState.listMetadata.mockResolvedValue([claudeMetadata]);
    testState.onTurnCommitted = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the dropped model once, even when the conversation is reopened', async () => {
    const warning = vi.spyOn(toast, 'warning');
    const first = await bootstrapStore('conversation-reopened', opusCleared);
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    expect(warning).toHaveBeenCalledWith(
      'Seçtiğiniz model (Claude Opus 4.8) bu oturumda sunulmuyor; varsayılan model kullanılıyor.',
      { id: 'acp-cleared-model:conversation-reopened' }
    );
    first.store.dispose();

    // The runtime keeps reporting the clearing while the model stays unset.
    const reopened = await bootstrapStore('conversation-reopened', opusCleared);
    expect(reopened.loadHistory).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
    expect(testState.listMetadata).toHaveBeenCalledOnce();
    reopened.store.dispose();
  });

  it('falls back to the generic notice when the runtime reports only the key', async () => {
    const warning = vi.spyOn(toast, 'warning');
    const { store } = await bootstrapStore('conversation-keys-only', {
      clearedConfiguration: ['model'],
    });

    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    expect(warning).toHaveBeenCalledWith(
      'Seçtiğiniz model bu oturumda sunulmuyor; varsayılan model kullanılıyor.',
      { id: 'acp-cleared-model:conversation-keys-only' }
    );
    expect(testState.listMetadata).not.toHaveBeenCalled();
    store.dispose();
  });

  it('shows the raw model id when the catalog cannot be read', async () => {
    testState.listMetadata.mockRejectedValueOnce(new Error('catalog unavailable'));
    const warning = vi.spyOn(toast, 'warning');
    const { store } = await bootstrapStore('conversation-no-catalog', opusCleared);

    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    expect(warning).toHaveBeenCalledWith(
      'Seçtiğiniz model (claude-opus-4-8) bu oturumda sunulmuyor; varsayılan model kullanılıyor.',
      { id: 'acp-cleared-model:conversation-no-catalog' }
    );
    store.dispose();
  });

  it('announces a clearing first reported by a history refresh', async () => {
    const warning = vi.spyOn(toast, 'warning');
    const { store, loadHistory } = await bootstrapStore('conversation-refreshed', {});
    expect(warning).not.toHaveBeenCalled();

    // A prompt woke the suspended session, and the new session no longer offers the model.
    loadHistory.mockResolvedValueOnce({ success: true, data: historyPage(opusCleared) });
    testState.onTurnCommitted?.();

    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    expect(warning).toHaveBeenCalledWith(
      'Seçtiğiniz model (Claude Opus 4.8) bu oturumda sunulmuyor; varsayılan model kullanılıyor.',
      { id: 'acp-cleared-model:conversation-refreshed' }
    );
    store.dispose();
  });
});

class FakeRemote<T> {
  constructor(private readonly value: T) {}

  current(): T {
    return this.value;
  }

  onChange(): () => void {
    return () => {};
  }
}

function historyPage(
  report: Pick<LoadHistoryResult, 'clearedConfiguration' | 'clearedValues'>
): LoadHistoryResult {
  return { turns: [], nextCursor: null, ...report };
}

async function bootstrapStore(
  conversationId: string,
  report: Pick<LoadHistoryResult, 'clearedConfiguration' | 'clearedValues'>
) {
  const loadHistory = vi.fn<AcpLiveSession['loadHistory']>(async () => ({
    success: true,
    data: historyPage(report),
  }));
  const session = {
    sessionState: new FakeRemote(idleState()),
    config: new FakeRemote({ availableCommands: [] }),
    usage: new FakeRemote(null),
    plan: new FakeRemote(null),
    activeTurn: new FakeRemote(null),
    terminals: new FakeRemote([]),
    mcpServers: new FakeRemote([]),
    loadHistory,
    terminalOutput: vi.fn(),
    usable: true,
    dispose: vi.fn(),
  } as unknown as AcpLiveSession;
  vi.spyOn(AcpLiveSession, 'create').mockResolvedValueOnce(session);
  const store = new AcpChatStore(conversationId, 'project-1', 'task-1');
  store.bootstrap();
  await vi.waitFor(() => expect(store.historyLoading).toBe(false));
  return { store, loadHistory };
}

function idleState(): SessionState {
  return {
    lifecycle: 'ready',
    activeTurnId: null,
    pendingPermissions: [],
    lastStopReason: null,
    lastTurnErrored: false,
    queuedPrompts: [],
    agentTurnActive: false,
    backgroundAgentCount: 0,
    isGenerating: false,
    canSubmit: true,
    canCancel: false,
  };
}
