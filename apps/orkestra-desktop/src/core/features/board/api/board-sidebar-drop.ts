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
  /** True when the app must open the Board view after applying the plan. */
  readonly navigate: boolean;
  /** Tile that becomes the focused one on the Board. */
  readonly focusTaskId: string | undefined;
  readonly toast: 'board-full' | undefined;
}

/**
 * Decides what dropping a task on the main area does. The Board is additive: existing tiles are
 * kept, the task currently open in a task view joins them, and the dropped task is appended
 * unless it is already there. When the dropped task does not fit nothing changes at all.
 */
export function planSidebarDrop({
  tiles,
  currentView,
  dragged,
}: SidebarDropInput): SidebarDropPlan {
  const alreadyThere = tiles.some((tile) => tile.taskId === dragged.taskId);
  const onBoard = currentView.kind === 'board';

  if (alreadyThere) {
    return {
      tiles,
      navigate: !onBoard,
      focusTaskId: dragged.taskId,
      toast: undefined,
    };
  }

  const opened =
    currentView.kind === 'task' && currentView.taskId !== dragged.taskId
      ? { projectId: currentView.projectId, taskId: currentView.taskId }
      : undefined;
  const openedMissing =
    opened !== undefined && !tiles.some((tile) => tile.taskId === opened.taskId);
  const slotsNeeded = openedMissing ? 2 : 1;

  if (tiles.length >= MAX_BOARD_TILES) {
    return { tiles, navigate: false, focusTaskId: undefined, toast: 'board-full' };
  }

  // The dropped task has priority over the task that was already open: with a single free slot the
  // open task is left out rather than refusing the drop.
  const base =
    openedMissing && tiles.length + slotsNeeded <= MAX_BOARD_TILES ? addTile(tiles, opened) : tiles;
  return {
    tiles: addTile(base, dragged),
    navigate: !onBoard,
    focusTaskId: dragged.taskId,
    toast: undefined,
  };
}
