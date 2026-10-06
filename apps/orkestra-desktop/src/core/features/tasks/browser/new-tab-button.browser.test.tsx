import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { NewTabButton } from './new-tab-button';

const fixture = vi.hoisted(() => ({
  open: vi.fn(),
  openModal: vi.fn(async () => ({ success: false as const })),
}));

vi.mock('@core/features/tasks/contributions/browser/task-view-context', () => ({
  useTaskViewContext: () => ({ projectId: 'project-1', taskId: 'task-1' }),
}));
vi.mock('@core/manifests/browser/modal-api', () => ({
  useOpenModal: () => fixture.openModal,
}));
vi.mock('@core/primitives/workbench-shell/browser/tabs/pane-context', () => ({
  usePaneContext: () => ({ pane: { open: fixture.open } }),
}));
vi.mock('@core/primitives/keybindings/browser/shortcut', () => ({
  BoundShortcut: () => null,
}));

describe('NewTabButton', () => {
  let container: HTMLDivElement;
  let root: Root;
  const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;

  beforeEach(() => {
    env.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<NewTabButton />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  });

  it('opens a menu with conversation and browser entries on click', async () => {
    await userEvent.click(page.getByRole('button', { name: 'Yeni sekme' }));
    await expect.element(page.getByRole('menuitem', { name: /Yeni sohbet/ })).toBeVisible();
    await expect.element(page.getByRole('menuitem', { name: /Tarayıcı/ })).toBeVisible();
  });

  it('opens a browser tab in this pane', async () => {
    await userEvent.click(page.getByRole('button', { name: 'Yeni sekme' }));
    await userEvent.click(page.getByRole('menuitem', { name: /Tarayıcı/ }));
    expect(fixture.open).toHaveBeenCalledWith('browser', {});
  });

  it('starts the new conversation flow', async () => {
    await userEvent.click(page.getByRole('button', { name: 'Yeni sekme' }));
    await userEvent.click(page.getByRole('menuitem', { name: /Yeni sohbet/ }));
    await vi.waitFor(() =>
      expect(fixture.openModal).toHaveBeenCalledWith({ projectId: 'project-1', taskId: 'task-1' })
    );
  });
});
