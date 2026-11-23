import { addTile, MAX_BOARD_TILES, type BoardTileRef } from './board-layout';

/** What the main area is showing when a sidebar item is dropped on it. */
export type SidebarDropView =
  | { readonly kind: 'board' }
  | { readonly kind: 'task'; readonly projectId: string; readonly taskId: string }
  | { readonly kind: 'other' };

export interface SidebarDropInput {
  readonly tiles: readonly BoardTileRef[];
  readonly currentView: SidebarDropView;
  readonly dragged: BoardTileRef;
}

export interface SidebarDropPlan {
  readonly tiles: readonly BoardTileRef[];
  /** True when `tiles` replaces existing board tiles directly (two-pane drag from a task). */
  readonly replace?: boolean;
  /** True when the app must open the Board view after applying the plan. */
  readonly navigate: boolean;
  /** Tile that becomes the focused one on the Board. */
  readonly focusTaskId: string | undefined;
  readonly toast: 'board-full' | undefined;
}

/**
 * Decides what dropping a conversation/task on the main area does:
 * - From a single task view: immediately places the currently open task and the
 *   dragged task cleanly side by side (two panes) without reviving unrelated old tiles.
 * - From the Board or any other view: appends up to MAX_BOARD_TILES (6).
 */
export function planSidebarDrop({
  tiles,
  currentView,
  dragged,
}: SidebarDropInput): SidebarDropPlan {
  const onBoard = currentView.kind === 'board';

  if (currentView.kind === 'task' && currentView.taskId !== dragged.taskId) {
    const opened: BoardTileRef = {
      projectId: currentView.projectId,
      taskId: currentView.taskId,
    };
    return {
      tiles: [opened, dragged],
      replace: true,
      navigate: true,
      focusTaskId: dragged.taskId,
      toast: undefined,
    };
  }

  const alreadyThere = tiles.some((tile) => tile.taskId === dragged.taskId);
  if (alreadyThere) {
    return {
      tiles,
      navigate: !onBoard,
      focusTaskId: dragged.taskId,
      toast: undefined,
    };
  }

  if (tiles.length >= MAX_BOARD_TILES) {
    return { tiles, navigate: false, focusTaskId: undefined, toast: 'board-full' };
  }

  return {
    tiles: addTile(tiles, dragged),
    navigate: !onBoard,
    focusTaskId: dragged.taskId,
    toast: undefined,
  };
}
