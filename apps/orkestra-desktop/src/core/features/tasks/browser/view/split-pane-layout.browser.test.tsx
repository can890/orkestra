import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLayoutNode } from '@core/primitives/workbench-shell/api/pane-layout';
import { SplitPaneLayout } from './task-main-column';

const fixture = vi.hoisted(() => ({
  layout: {} as PaneLayoutNode,
  setActiveGroup: vi.fn(),
  splitRight: vi.fn(),
  splitDown: vi.fn(),
}));
vi.mock('@core/features/workbench/api/browser/task-composition-context', () => ({
  useTaskComposition: () => ({
    paneLayout: {
      ...fixture,
      canInsertPane: true,
      groups: ['left', 'right-top', 'right-bottom'].map((paneId) => ({
        paneId,
        pane: { resolvedTabs: [{}, {}] },
      })),
    },
  }),
}));
vi.mock('@core/features/workbench/contributions/browser/tabs/pane-provider', () => ({
  PaneProvider: ({ group, children }: { group: { paneId: string }; children: ReactNode }) => (
    <div data-pane={group.paneId} style={{ height: '100%' }}>
      {children}
    </div>
  ),
}));
vi.mock('@core/primitives/workbench-shell/browser/tabs/pane-content', () => ({
  PaneContent: ({ trailingSlot }: { trailingSlot: ReactNode }) => <div>{trailingSlot}</div>,
}));
vi.mock('../new-tab-button', () => ({
  NewTabButton: () => <button>Yeni sekme</button>,
}));
vi.mock('../pane-empty-state', () => ({ PaneEmptyState: () => null }));
vi.mock('@core/features/terminals/contributions/browser/task-terminal/terminal-panel', () => ({
  TerminalsPanel: () => null,
}));
vi.mock('@core/primitives/workbench-shell/browser/tabs/tab-bar/tab-drag-preview', () => ({
  TabDragPreview: () => null,
}));

const storage = { getItem: () => null, setItem: vi.fn(), deleteEntry: vi.fn() };
describe('mixed split pane layout', () => {
  let container: HTMLDivElement;
  let root: Root;
  const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  beforeEach(() => {
    env.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement('div');
    container.style.cssText = 'width:900px;height:600px';
    document.body.append(container);
    root = createRoot(container);
    fixture.layout = {
      kind: 'split',
      id: 'horizontal',
      axis: 'horizontal',
      children: [
        { kind: 'pane', paneId: 'left' },
        {
          kind: 'split',
          id: 'vertical',
          axis: 'vertical',
          children: [
            { kind: 'pane', paneId: 'right-top' },
            { kind: 'pane', paneId: 'right-bottom' },
          ],
        },
      ],
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  });
  it('renders two stacked panes beside a full-height pane and targets the clicked pane', async () => {
    await act(async () => root.render(<SplitPaneLayout storage={storage} />));
    const rect = (id: string) =>
      container.querySelector(`[data-pane="${id}"]`)!.getBoundingClientRect();
    await vi.waitFor(() => expect(rect('left').height).toBeGreaterThan(500));
    expect(rect('right-top').left).toBeGreaterThan(rect('left').left + 300);
    expect(rect('right-bottom').top).toBeGreaterThan(rect('right-top').top + 150);
    expect(rect('right-bottom').left).toBeCloseTo(rect('right-top').left, 0);
    expect(rect('right-top').height).toBeLessThan(rect('left').height * 0.6);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-pane="right-top"] button[aria-label="Paneli alta böl"]'
        )!
        .click()
    );
    expect(fixture.setActiveGroup).toHaveBeenCalledWith('right-top');
    expect(fixture.splitDown).toHaveBeenCalledOnce();
  });
});
