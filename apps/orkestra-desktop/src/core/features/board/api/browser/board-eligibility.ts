import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { registeredTaskData, type TaskState } from '@core/primitives/task-state/browser/task-state';

/**
 * Whether a task may be shown on the Board: registered, not an automation run, not archived.
 * Shared by the Add-task picker, the sidebar context menu and sidebar drops.
 */
export function isBoardEligibleTask(task: TaskState): boolean {
  if (task.state === 'unregistered') return false;
  if (task.data.type === 'automation-run') return false;
  if ('archivedAt' in task.data && task.data.archivedAt) return false;
  return true;
}

/** Epoch milliseconds of the last interaction (falling back to the last update), 0 when unknown. */
export function taskRecency(task: TaskState): number {
  const data = registeredTaskData(task);
  const instant = data?.lastInteractedAt ?? data?.updatedAt;
  return instant ? Date.parse(instant) || 0 : 0;
}

/** Most recently interacted eligible task of a project. Call only from observers or actions. */
export function mostRecentEligibleTaskId(projectId: string): string | undefined {
  const manager = getTaskManagerStore(projectId);
  if (!manager) return undefined;
  let best: { id: string; at: number } | undefined;
  for (const task of manager.tasks.values()) {
    if (!isBoardEligibleTask(task)) continue;
    const at = taskRecency(task);
    if (!best || at > best.at) best = { id: task.data.id, at };
  }
  return best?.id;
}
