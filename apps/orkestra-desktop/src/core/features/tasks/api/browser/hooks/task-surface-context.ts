import { createContext, useContext } from 'react';

/**
 * Describes a surface that shows a Task outside the navigation-owned task view (for example a
 * board tile). `null` means the Task is shown by the regular task view and navigation decides
 * which Task is active.
 */
export interface TaskSurface {
  /** True for the surface the user is working in; exactly one mounted surface is active. */
  readonly isActive: boolean;
  /** Compact surfaces drop window chrome such as the right sidebar. */
  readonly compact: boolean;
}

export const TaskSurfaceContext = createContext<TaskSurface | null>(null);

export function useTaskSurface(): TaskSurface | null {
  return useContext(TaskSurfaceContext);
}
