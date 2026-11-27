import { toast } from '@orkestra/ui/react/primitives';
import type { BoardDropTarget, BoardTileRef } from '@core/features/board/api/board-layout';
import {
  planSideBySidePair,
  planSidebarDrop,
  type SidebarDropView,
} from '@core/features/board/api/board-sidebar-drop';
import { mostRecentEligibleTaskId } from '@core/features/board/api/browser/board-eligibility';
import { getBoardStore } from '@core/features/board/contributions/app-stores';
import { boardViewDef } from '@core/features/board/contributions/views';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';

/** Adds a task to the Board (if there is room) and opens the Board view. */
export function addTaskToBoard(ref: BoardTileRef): void {
  getBoardStore().add(ref);
  getNavigation().navigate(boardViewDef());
}

export function removeTaskFromBoard(taskId: string): void {
  getBoardStore().remove(taskId);
}

/** Call only inside `observer` components (or other MobX reactions) to stay reactive. */
export function isTaskOnBoard(taskId: string): boolean {
  return getBoardStore().hasTask(taskId);
}

function currentDropView(): SidebarDropView {
  const current = getNavigation().currentRef;
  if (current.viewId === boardViewDef.id) return { kind: 'board' };
  if (current.viewId === taskViewDef.id) {
    const { projectId, taskId } = current.params as { projectId?: string; taskId?: string };
    if (projectId && taskId) return { kind: 'task', projectId, taskId };
  }
  return { kind: 'other' };
}

/**
 * Applies a task dropped from the sidebar onto the main area: the task is placed according
 * to `dropTarget` (`left | right` = yan yana, `top | bottom` = alt alta).
 */
export function dropTaskOnMainArea(dragged: BoardTileRef, dropTarget?: BoardDropTarget): void {
  const board = getBoardStore();
  const plan = planSidebarDrop({
    tiles: board.tiles,
    currentLayout: board.layout,
    currentView: currentDropView(),
    dragged,
    dropTarget,
  });
  if (plan.toast === 'board-full') {
    toast('Board is full (6 tasks)');
    return;
  }
  if (plan.layout) {
    board.setLayout(plan.layout);
  } else if (plan.replace) {
    board.setTiles(plan.tiles);
  } else {
    for (const tile of plan.tiles) {
      if (!board.hasTask(tile.taskId)) board.add(tile);
    }
  }
  if (plan.focusTaskId) board.requestFocus(plan.focusTaskId);
  if (plan.navigate) getNavigation().navigate(boardViewDef());
}

/** Project header dropped on the main area: shows its most recently used eligible task. */
export function dropProjectOnMainArea(projectId: string, dropTarget?: BoardDropTarget): void {
  const taskId = mostRecentEligibleTaskId(projectId);
  if (!taskId) {
    toast('This project has no tasks to show');
    return;
  }
  dropTaskOnMainArea({ projectId, taskId }, dropTarget);
}

/**
 * Kaynak ve devredilen sohbet/görevlerini Panoda yan yana açar ve yeni göreve odaklanır.
 * Pano zaten 6 görevle doluysa kullanıcıyı doğrudan yeni göreve geçirir.
 */
export function openTasksSideBySideOnBoard(source: BoardTileRef, target: BoardTileRef): void {
  const board = getBoardStore();
  const plan = planSideBySidePair({
    tiles: board.tiles,
    currentLayout: board.layout,
    currentView: currentDropView(),
    source,
    target,
  });
  if (plan.fallbackToTargetTask) {
    if (plan.toast === 'board-full') {
      toast('Pano dolu (6 sohbet); yeni sohbet tek ekranda açıldı.');
    }
    getNavigation().navigate(taskViewDef(target));
    return;
  }
  if (plan.layout) {
    board.setLayout(plan.layout);
  } else if (plan.replace) {
    board.setTiles(plan.tiles);
  }
  if (plan.focusTaskId) board.requestFocus(plan.focusTaskId);
  if (plan.navigate) getNavigation().navigate(boardViewDef());
}
