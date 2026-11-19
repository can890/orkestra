import type { BoardTileRef } from '@core/features/board/api/board-layout';
import { getBoardStore } from '@core/features/board/contributions/app-stores';
import { boardViewDef } from '@core/features/board/contributions/views';
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
