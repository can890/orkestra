import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PaneEmptyState } from './pane-empty-state';

const mocks = vi.hoisted(() => ({
  createChat: vi.fn(),
  openTab: vi.fn(),
  openModal: vi.fn(),
}));

vi.mock('@core/features/conversations/api/browser/quick-conversation', () => ({
  createQuickConversation: mocks.createChat,
}));

vi.mock('@core/features/tasks/contributions/browser/task-view-context', () => ({
  useTaskViewContext: () => ({ projectId: 'project-1', taskId: 'task-1' }),
}));

vi.mock('@core/features/workbench/api/browser/task-composition-context', () => ({
  useWorkspaceId: () => 'workspace-1',
}));

vi.mock('@core/manifests/browser/modal-api', () => ({
  useOpenModal: () => mocks.openModal,
}));

vi.mock('@core/primitives/keybindings/browser/shortcut', () => ({
  BoundShortcut: () => null,
}));

vi.mock('@core/primitives/workbench-shell/browser/tabs/pane-context', () => ({
  usePaneContext: () => ({ pane: { open: mocks.openTab } }),
}));

it('opens a conversation in the empty pane without opening the provider dialog', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.createChat.mockResolvedValue({ id: 'chat-1', type: 'acp' });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  try {
    await act(async () => root.render(<PaneEmptyState />));
    const newChat = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('New conversation')
    );
    expect(newChat).toBeDefined();
    await act(async () => newChat?.click());
    expect(mocks.createChat).toHaveBeenCalledWith({ projectId: 'project-1', taskId: 'task-1' });
    expect(mocks.openTab).toHaveBeenCalledWith(
      'acp-chat',
      { conversationId: 'chat-1' },
      { preview: false }
    );
    expect(mocks.openModal).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
