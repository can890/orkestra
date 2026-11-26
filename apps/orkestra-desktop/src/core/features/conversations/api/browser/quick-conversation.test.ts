import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuickConversation } from './quick-conversation';

const mocks = vi.hoisted(() => ({
  createConversation: vi.fn(),
  fetchSettings: vi.fn(),
  resolveAgent: vi.fn(),
  recordAgent: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@orkestra/ui/react/primitives', () => ({
  toast: { error: mocks.toastError },
}));

vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectSshConnectionId: () => 'machine-1',
}));

vi.mock('@core/features/settings/api/browser/app-settings-client', () => ({
  fetchAppSettingsMeta: mocks.fetchSettings,
}));

vi.mock('./conversation-selectors', () => ({
  getConversationsForTask: () => ({
    createConversation: mocks.createConversation,
    conversations: new Map(),
  }),
}));

vi.mock('./last-used-agent', () => ({
  resolveLastUsedAgentForHost: mocks.resolveAgent,
  recordLastUsedAgent: mocks.recordAgent,
}));

const task = { projectId: 'project-1', taskId: 'task-1' };

describe('createQuickConversation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.fetchSettings.mockImplementation(async (key) =>
      key === 'defaultAgent'
        ? { value: 'claude' }
        : { value: { defaultPermissionMode: 'plan' }, overrides: {} }
    );
  });

  it('creates and remembers the last available provider with its model and effort', async () => {
    mocks.resolveAgent.mockResolvedValue({
      providerId: 'codex',
      model: 'gpt-6.2-sol',
      effort: 'high',
      supportsAcp: true,
      supportsAutoApprove: true,
    });
    const created = { id: 'chat-1', type: 'acp' };
    mocks.createConversation.mockResolvedValue(created);

    const pending = createQuickConversation(task);
    await expect(createQuickConversation(task)).resolves.toBeNull();
    await expect(pending).resolves.toEqual(created);

    expect(mocks.resolveAgent).toHaveBeenCalledWith({
      connectionId: 'machine-1',
      defaultAgent: 'claude',
    });
    expect(mocks.createConversation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...task,
        provider: 'codex',
        model: 'gpt-6.2-sol',
        effort: 'high',
        modeId: 'read-only',
        autoApprove: false,
        type: 'acp',
      })
    );
    expect(mocks.recordAgent).toHaveBeenCalledWith({
      providerId: 'codex',
      model: 'gpt-6.2-sol',
      effort: 'high',
    });
  });

  it('reports an unavailable provider and releases the task so a retry can open a chat', async () => {
    mocks.resolveAgent.mockResolvedValueOnce({ providerId: null });
    await expect(createQuickConversation(task)).resolves.toBeNull();
    expect(mocks.toastError).toHaveBeenCalledOnce();
    expect(mocks.createConversation).not.toHaveBeenCalled();

    mocks.resolveAgent.mockResolvedValue({
      providerId: 'codex',
      supportsAcp: true,
      supportsAutoApprove: true,
    });
    mocks.createConversation.mockResolvedValue({ id: 'chat-2' });
    await expect(createQuickConversation(task)).resolves.toEqual({ id: 'chat-2' });
  });
});
