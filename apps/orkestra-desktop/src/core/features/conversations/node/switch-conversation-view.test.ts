import { describe, expect, it, vi, beforeEach } from 'vitest';
import { resolveConversationHostClient } from './host-mutation';
import type { HostConversationMutationDeps } from './host-mutation';
import { switchConversationView } from './switch-conversation-view';

const cache = vi.hoisted(() => ({ row: {} as Record<string, unknown>, refresh: vi.fn() }));
vi.mock('./host-mutation', () => ({ resolveConversationHostClient: vi.fn() }));
vi.mock('@core/features/conversations/api/node/registry', () => ({
  createConversationRegistry: () => ({ refresh: cache.refresh, getLive: () => cache.row }),
}));
vi.mock('./event-host', () => ({ conversationWireEvents: { emit: vi.fn() } }));
vi.mock('@core/services/app-db/node/pokes', () => ({
  appDbPokes: { conversations: { poke: vi.fn() } },
}));

const deps = {} as HostConversationMutationDeps;
function fixture(type: 'pty' | 'acp' = 'acp') {
  const record = {
    conversationId: 'c1',
    provider: 'claude',
    type,
    cwd: '/work',
    workspacePath: '/work',
    idRegime: 'provider-minted',
    createdAt: 1,
    title: 'My conversation',
    config: { version: '1', type, model: 'model', autoApprove: false },
    providerSessionId: 'native-session',
    providerSessionIdObservedAt: 2,
    lastSessionActivityAt: 2,
    lastSpawnedAt: 1,
    lastResumeOutcome: 'loaded',
    updatedAt: 2,
  };
  cache.row = {
    id: 'c1',
    projectId: 'p1',
    taskId: 't1',
    provider: 'claude',
    type,
    config: record.config,
    title: record.title,
    providerSessionId: record.providerSessionId,
  };
  cache.refresh.mockImplementation((_id, observation) => Object.assign(cache.row, observation));
  const acp: Record<string, unknown> = {};
  const tui: Record<string, unknown> = {};
  const agents: Record<string, unknown> = {};
  const live = (data: unknown) => ({
    state: () => ({ asLiveSource: () => ({ snapshot: async () => ({ data }) }) }),
  });
  const order: string[] = [];
  const stop = vi.fn(async () => {
    order.push('stop');
    return { success: true };
  });
  const switchType = vi.fn(async (input) => {
    order.push('switch');
    return { success: true, data: { ...record, type: input.type, config: input.config } };
  });
  vi.mocked(resolveConversationHostClient).mockResolvedValue({
    row: cache.row,
    client: { records: live({ c1: record }), switchType },
    runtime: {
      acp: { sessions: live(acp), terminate: stop },
      tuiAgents: { sessions: live(tui), agentStates: live(agents), kill: stop },
    },
  } as never);
  return { record, acp, tui, agents, stop, switchType, order };
}
const idleChat = {
  conversationId: 'c1',
  providerId: 'claude',
  lifecycle: 'ready',
  isGenerating: false,
  lastStopReason: null,
  lastTurnErrored: false,
  pendingPermissionCount: 0,
  backgroundAgentCount: 0,
  queuedPromptCount: 0,
  title: null,
  updatedAt: 1,
};
const idleTerminal = {
  conversationId: 'c1',
  sessionId: 'native-session',
  status: 'running',
  cols: 80,
  rows: 24,
  resume: null,
  startedAt: 1,
};

beforeEach(() => vi.clearAllMocks());

describe('conversation runtime handoff', () => {
  it.each(['pty', 'acp'] as const)(
    'switches from %s after stopping its old runtime and preserves history identity',
    async (type) => {
      const f = fixture(type);
      const target = type === 'pty' ? 'acp' : 'pty';
      const result = await switchConversationView(deps, 'c1', target);
      expect(result).toMatchObject({
        success: true,
        data: { id: 'c1', sessionId: 'native-session', type: target, title: 'My conversation' },
      });
      expect(f.order).toEqual(['stop', 'switch']);
      expect(f.switchType).toHaveBeenCalledWith(
        expect.objectContaining({ expectedType: type, expectedSessionId: 'native-session' })
      );
    }
  );
  it.each([
    { isGenerating: true },
    { pendingPermissionCount: 1 },
    { backgroundAgentCount: 1 },
    { queuedPromptCount: 1 },
    { lifecycle: 'replaying' },
  ])('leaves busy chat untouched: %j', async (busy) => {
    const f = fixture();
    f.acp.c1 = { ...idleChat, ...busy };
    expect(await switchConversationView(deps, 'c1', 'pty')).toMatchObject({ success: false });
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.switchType).not.toHaveBeenCalled();
  });
  it('rejects an active terminal with unknown or working state and permits a known idle terminal', async () => {
    const f = fixture('pty');
    f.tui.c1 = idleTerminal;
    expect(await switchConversationView(deps, 'c1', 'acp')).toMatchObject({ success: false });
    f.agents.c1 = { conversationId: 'c1', status: 'working', updatedAt: 1 };
    expect(await switchConversationView(deps, 'c1', 'acp')).toMatchObject({ success: false });
    expect(f.stop).not.toHaveBeenCalled();
    f.agents.c1 = {
      conversationId: 'c1',
      status: 'awaiting-input',
      notificationType: 'idle_prompt',
      updatedAt: 2,
    };
    expect(await switchConversationView(deps, 'c1', 'acp')).toMatchObject({ success: true });
  });
  it('does not overwrite the index or cache when stopping the source fails', async () => {
    const f = fixture();
    f.stop.mockResolvedValue({ success: false });
    expect(await switchConversationView(deps, 'c1', 'pty')).toMatchObject({ success: false });
    expect(f.switchType).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });
  it('rejects missing native handles before stopping anything', async () => {
    const f = fixture();
    Object.assign(f.record, { providerSessionId: null });
    expect(await switchConversationView(deps, 'c1', 'pty')).toMatchObject({ success: false });
    expect(f.stop).not.toHaveBeenCalled();
  });
  it('refreshes a stale cache when the host already uses the requested view', async () => {
    const f = fixture('pty');
    cache.row.type = 'acp';
    expect(await switchConversationView(deps, 'c1', 'pty')).toMatchObject({
      success: true,
      data: { type: 'pty' },
    });
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.switchType).not.toHaveBeenCalled();
  });
});
