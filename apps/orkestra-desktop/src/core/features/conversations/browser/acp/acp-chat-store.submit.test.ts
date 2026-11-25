import type { SessionState } from '@orkestra/core/runtimes/acp/api/client';
import { observable, runInAction } from 'mobx';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as agentsClientModule from '@core/features/agents/api/browser/client';
import { installChatUiRuntime } from '@core/features/conversations/api/browser/chat/chat-ui-runtime';
import type * as projectSelectorsModule from '@core/features/projects/api/browser/stores/project-selectors';
import { AcpChatStore } from './acp-chat-store';
import { AcpLiveSession } from './acp-live-session';
import { HOLD_REASON_HOST } from './composer-submit';

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

// Mesaj kutusu: gönderim hiçbir durumda onay sormaz ve çalışan turu durdurmaz; iletilemeyen mesaj
// taslakta kalır, bağlanan oturumda bağlantı gelince gönderilir.
describe('AcpChatStore submit never locks, asks or stops the turn', () => {
  beforeAll(() => {
    testState.listMetadata.mockResolvedValue([]);
    installChatUiRuntime({
      createChatContext: () => ({}) as never,
      createChatState: () =>
        ({
          session: { state: { pendingPrompt: null }, setPendingPrompt: vi.fn() },
          transcript: {
            state: { displayTurns: [], committedTurns: [], activeTurnSnapshot: null },
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['an agent that steers (Claude Code, Codex)', true, 'steer'],
    ['Antigravity (steering answered with queueRequired)', true, 'steer'],
    ['an agent without mid-turn input (Grok, Kimi, custom ACP)', false, 'queue'],
  ] as const)(
    'sending while %s works never cancels the turn',
    async (_label, supportsSteering, placement) => {
      const { store, session } = await bootstrap({ working: true, supportsSteering });
      store.submitPrompt('araya mesaj', [], undefined, placement);
      await vi.waitFor(() => expect(session.sendPrompt).toHaveBeenCalledOnce());
      expect(session.sendPrompt.mock.calls[0]?.[1]).toBe(placement);
      expect(session.cancelTurn).not.toHaveBeenCalled();
      expect(store.submitHoldReason).toBeNull();
      store.dispose();
    }
  );

  it('"send now" on a queued message stops the turn only when the user asks, without a dialog', async () => {
    const { store, session } = await bootstrap({ working: true, supportsSteering: false });
    expect(session.cancelTurn).not.toHaveBeenCalled();
    store.sendQueuedPromptNow('queued-1');
    await vi.waitFor(() => expect(session.cancelTurn).toHaveBeenCalledOnce());
    expect(session.changeQueuePromptOrder).toHaveBeenCalledWith(['queued-1']);
    store.dispose();
  });

  it('keeps the draft and shows a reason when the project host is offline', async () => {
    const hostAccess = {
      state: { kind: 'unavailable' },
      liveAction: { kind: 'disabled' },
      recover: vi.fn(async () => {}),
    };
    const store = new AcpChatStore('conv-offline', 'project-1', 'task-1', hostAccess as never);
    store.setDraftText('kaybolmasın');
    store.submitPrompt('kaybolmasın');
    expect(store.draftText).toBe('kaybolmasın');
    expect(store.submitHoldReason).toBe(HOLD_REASON_HOST);
    store.dispose();
  });

  it('sends a message typed while the session reconnects as soon as it is usable again', async () => {
    const { store, session, usable } = await bootstrap({ working: false, supportsSteering: true });
    runInAction(() => usable.set(false));
    store.submitPrompt('yeniden bağlanırken');
    await Promise.resolve();
    expect(session.sendPrompt).not.toHaveBeenCalled();
    expect(store.submitHoldReason).toBeNull();
    runInAction(() => usable.set(true));
    await vi.waitFor(() => expect(session.sendPrompt).toHaveBeenCalledOnce());
    expect(session.sendPrompt.mock.calls[0]?.[0]).toMatchObject({ text: 'yeniden bağlanırken' });
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

async function bootstrap(options: { working: boolean; supportsSteering: boolean }) {
  const usable = observable.box(true);
  const state: SessionState = {
    lifecycle: options.working ? 'working' : 'ready',
    activeTurnId: options.working ? 'turn-1' : null,
    pendingPermissions: [],
    lastStopReason: null,
    lastTurnErrored: false,
    queuedPrompts: [
      { id: 'queued-1', text: 'sırada', createdAt: 0, updatedAt: 0 },
    ] as SessionState['queuedPrompts'],
    agentTurnActive: false,
    backgroundAgentCount: 0,
    isGenerating: options.working,
    canSubmit: !options.working,
    canCancel: options.working,
    ...(options.supportsSteering ? { supportsSteering: true as const } : {}),
  };
  const session = {
    sessionState: new FakeRemote(state),
    config: new FakeRemote({ availableCommands: [] }),
    usage: new FakeRemote(null),
    plan: new FakeRemote(null),
    activeTurn: new FakeRemote(null),
    terminals: new FakeRemote([]),
    mcpServers: new FakeRemote([]),
    loadHistory: vi.fn(async () => ({ success: true, data: { turns: [], nextCursor: null } })),
    terminalOutput: vi.fn(),
    get usable() {
      return usable.get();
    },
    sendPrompt: vi.fn(async (_prompt: unknown, _placement?: unknown, _promptId?: string) => ({
      success: true,
      data: { queued: options.working },
    })),
    cancelTurn: vi.fn(async () => ({ success: true, data: undefined })),
    changeQueuePromptOrder: vi.fn(async () => ({ success: true, data: undefined })),
    dispose: vi.fn(),
  };
  vi.spyOn(AcpLiveSession, 'create').mockResolvedValueOnce(session as unknown as AcpLiveSession);
  const store = new AcpChatStore(`conv-${Math.random()}`, 'project-1', 'task-1');
  store.bootstrap();
  await vi.waitFor(() => expect(store.historyLoading).toBe(false));
  await vi.waitFor(() => expect(store.session).not.toBeNull());
  return { store, session, usable };
}
