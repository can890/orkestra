import { useTaskSurface } from '@core/features/tasks/api/browser/hooks/task-surface-context';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import {
  useViewParams,
  useWorkspaceSlots,
} from '@core/primitives/navigation/browser/navigation-hooks';

export function useIsActiveTask(taskId: string): boolean {
  const surface = useTaskSurface();
  const { currentView } = useWorkspaceSlots();
  const params = useViewParams(taskViewDef);
  if (surface) return surface.isActive;
  return currentView === 'task' && params?.taskId === taskId;
}
