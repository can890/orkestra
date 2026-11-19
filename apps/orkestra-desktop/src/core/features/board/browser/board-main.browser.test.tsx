import { observable, runInAction } from 'mobx';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardLayoutState } from '@core/features/board/contributions/mementos';
import type { MementoHandle } from '@core/primitives/mementos/browser';
import { BoardStore } from './board-store';

const fixture = vi.hoisted(() => ({ store: undefined as unknown }));

vi.mock('@core/features/board/contributions/app-stores', () => ({
  getBoardStore: () => fixture.store,
}));
vi.mock('@core/features/tasks/contributions/browser/embedded-task-view', () => ({
  EmbeddedTaskView: ({
    taskId,
    isActive,
  }: {
    projectId: string;
    taskId: string;
    isActive: boolean;
  }) => <div data-testid="embedded" data-task-id={taskId} data-active={String(isActive)} />,
}));
vi.mock('./board-task-picker', () => ({
  BoardAddTaskButton: () => <button type="button">Add task</button>,
}));
vi.mock('./board-project-info', () => ({
  useProjectsLoaded: () => true,
  boardProjectName: (projectId: string) => `Project ${projectId}`,
  boardProjectHostLabel: () => undefined,
}));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskStore: () => undefined,
}));
vi.mock('@core/features/conversations/api/browser/conversation-selectors', () => ({
  taskAgentStatus: () => null,
}));
vi.mock('@core/primitives/navigation/browser/navigation-hooks', () => ({
  useNavigate: () => ({ navigate: vi.fn() }),
}));

const { BoardMain } = await import('./board-main');

function createStore(taskIds: string[]): BoardStore {
  const cell = observable.box<BoardLayoutState>(
    { version: '1', tiles: taskIds.map((taskId) => ({ projectId: 'p', taskId })) },
    { deep: false }
  );
  const handle = {
    get value() {
      return cell.get();
    },
    ready: Promise.resolve(),
    update(next: BoardLayoutState | ((current: BoardLayoutState) => BoardLayoutState)) {
      runInAction(() => cell.set(typeof next === 'function' ? next(cell.get()) : next));
    },
  } as unknown as MementoHandle<BoardLayoutState>;
  return new BoardStore(() => handle);
}

describe('BoardMain', () => {
  let container: HTMLDivElement;
  let root: Root;
  const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;

  beforeEach(() => {
    env.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    container.style.cssText = 'width:1200px;height:800px';
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  });

  async function render(taskIds: string[]) {
    fixture.store = createStore(taskIds);
    await act(async () => {
      root.render(<BoardMain />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  const tiles = () => [...container.querySelectorAll<HTMLElement>('[data-testid="board-tile"]')];
  const grid = () => container.querySelector<HTMLElement>('[data-testid="board-grid"]');
  const activeIds = () =>
    [
      ...container.querySelectorAll<HTMLElement>('[data-testid="embedded"][data-active="true"]'),
    ].map((node) => node.dataset.taskId);
  const button = (tile: HTMLElement, label: string) =>
    tile.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  it('shows the empty state with an add action when there are no tiles', async () => {
    await render([]);
    expect(container.textContent).toContain('See several tasks side by side');
    expect(container.textContent).toContain('Add task');
    expect(grid()).toBeNull();
  });

  it.each([
    [1, '1', '1'],
    [2, '2', '1'],
    [4, '2', '2'],
    [5, '3', '2'],
    [6, '3', '2'],
  ])('lays out %i tiles as %s x %s', async (count, columns, rows) => {
    await render(Array.from({ length: count }, (_, i) => `t${i}`));
    expect(tiles()).toHaveLength(count);
    expect(grid()?.dataset.columns).toBe(columns);
    expect(grid()?.dataset.rows).toBe(rows);
    expect(grid()?.style.gridTemplateColumns).toBe(`repeat(${columns}, minmax(0px, 1fr))`);
    const first = tiles()[0]!.getBoundingClientRect();
    expect(first.width).toBeGreaterThan(0);
    expect(first.height).toBeGreaterThan(0);
  });

  it('keeps exactly one tile active and moves it on pointer down', async () => {
    await render(['a', 'b', 'c']);
    expect(activeIds()).toEqual(['a']);
    await act(async () => {
      tiles()[2]!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(activeIds()).toEqual(['c']);
    expect(tiles().filter((tile) => tile.dataset.focused === 'true')).toHaveLength(1);
  });

  it('removes a tile and hands focus to a neighbour', async () => {
    await render(['a', 'b', 'c']);
    await act(async () => {
      button(tiles()[0]!, 'Remove from board')!.click();
    });
    expect(tiles().map((tile) => tile.dataset.taskId)).toEqual(['b', 'c']);
    expect(activeIds()).toEqual(['b']);
  });

  it('maximizes one tile and restores the grid', async () => {
    await render(['a', 'b', 'c', 'd']);
    await act(async () => {
      button(tiles()[1]!, 'Maximize')!.click();
    });
    expect(tiles().map((tile) => tile.dataset.taskId)).toEqual(['b']);
    expect(activeIds()).toEqual(['b']);
    await act(async () => {
      button(tiles()[0]!, 'Shrink to grid')!.click();
    });
    expect(tiles()).toHaveLength(4);
    expect(grid()?.dataset.columns).toBe('2');
    expect(activeIds()).toEqual(['b']);
  });

  it('toggles maximize on header double-click', async () => {
    await render(['a', 'b']);
    await act(async () => {
      tiles()[0]!
        .querySelector('header')!
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(tiles()).toHaveLength(1);
  });
});
