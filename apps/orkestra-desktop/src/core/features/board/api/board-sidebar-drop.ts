import {
  addTile,
  buildDefaultBoardLayout,
  insertTileInBoardLayout,
  MAX_BOARD_TILES,
  tilesFromLayout,
  type BoardDropTarget,
  type BoardLayoutNode,
  type BoardTileRef,
} from './board-layout';

/** What the main area is showing when a sidebar item is dropped on it. */
export type SidebarDropView =
  | { readonly kind: 'board' }
  | { readonly kind: 'task'; readonly projectId: string; readonly taskId: string }
  | { readonly kind: 'other' };

export interface SidebarDropInput {
  readonly tiles: readonly BoardTileRef[];
  readonly currentLayout?: BoardLayoutNode | null;
  readonly currentView: SidebarDropView;
  readonly dragged: BoardTileRef;
  readonly dropTarget?: BoardDropTarget;
}

export interface SidebarDropPlan {
  readonly tiles: readonly BoardTileRef[];
  readonly layout?: BoardLayoutNode;
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
 * - From a single task view: immediately opens the open task + dropped task cleanly in the
 *   requested direction (`left | right | top | bottom`), defaulting to side by side.
 * - From the Board or any other view: appends (or moves/re-arranges) up to MAX_BOARD_TILES (6).
 */
export function planSidebarDrop({
  tiles,
  currentLayout,
  currentView,
  dragged,
  dropTarget,
}: SidebarDropInput): SidebarDropPlan {
  const onBoard = currentView.kind === 'board';

  if (currentView.kind === 'task' && currentView.taskId !== dragged.taskId) {
    const opened: BoardTileRef = {
      projectId: currentView.projectId,
      taskId: currentView.taskId,
    };
    const side = dropTarget?.side ?? 'right';
    const layout = insertTileInBoardLayout(
      { kind: 'tile', projectId: opened.projectId, taskId: opened.taskId },
      dragged,
      { side }
    );
    return {
      tiles: tilesFromLayout(layout),
      ...(dropTarget ? { layout } : {}),
      replace: true,
      navigate: true,
      focusTaskId: dragged.taskId,
      toast: undefined,
    };
  }

  const alreadyThere = tiles.some((tile) => tile.taskId === dragged.taskId);
  if (alreadyThere) {
    if (dropTarget?.targetTaskId && dropTarget.targetTaskId !== dragged.taskId) {
      const baseLayout = currentLayout ?? buildDefaultBoardLayout(tiles, 'horizontal');
      const layout = insertTileInBoardLayout(baseLayout, dragged, dropTarget);
      return {
        tiles: tilesFromLayout(layout),
        layout,
        replace: true,
        navigate: !onBoard,
        focusTaskId: dragged.taskId,
        toast: undefined,
      };
    }
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

  if (dropTarget) {
    const baseLayout = currentLayout ?? buildDefaultBoardLayout(tiles, 'horizontal');
    const layout = insertTileInBoardLayout(baseLayout, dragged, dropTarget);
    return {
      tiles: tilesFromLayout(layout),
      ...(layout.kind === 'split' ? { layout } : {}),
      replace: true,
      navigate: !onBoard,
      focusTaskId: dragged.taskId,
      toast: undefined,
    };
  }

  return {
    tiles: addTile(tiles, dragged),
    navigate: !onBoard,
    focusTaskId: dragged.taskId,
    toast: undefined,
  };
}
