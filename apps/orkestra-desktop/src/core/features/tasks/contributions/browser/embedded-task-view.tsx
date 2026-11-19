import { observer } from 'mobx-react-lite';
import { Component, useEffect, useMemo, type ErrorInfo, type ReactNode } from 'react';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import {
  TaskSurfaceContext,
  type TaskSurface,
} from '@core/features/tasks/api/browser/hooks/task-surface-context';
import {
  getTaskStore,
  taskViewKind,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { TaskMainPanel, TaskViewLoadingState } from '@core/features/tasks/browser/main-panel';
import { TaskScope } from '@core/features/tasks/browser/task-scope';
import { getTaskActivationCoordinator } from '@core/features/tasks/contributions/app-stores';
import { TaskViewWrapper } from '@core/features/tasks/contributions/browser/task-view-context';
import {
  clearFocusedTaskSurface,
  setFocusedTaskSurface,
} from '@core/features/workbench/api/browser/focused-task-surface';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { log } from '@core/primitives/logging/browser/logger';

export interface EmbeddedTaskViewProps {
  readonly projectId: string;
  readonly taskId: string;
  /**
   * True for the surface the user is currently working in. Drives view-scope activation,
   * autofocus and mark-seen; exactly one mounted surface should be active at a time.
   */
  readonly isActive: boolean;
}

/**
 * Renders one task's main panel (every lifecycle state, panes, tabs) outside the
 * navigation-owned task view, so several tasks can be on screen at once. It is compact: no
 * window titlebar and never the right task sidebar (derived, the saved chrome state is untouched).
 *
 * While mounted it keeps the task's pane layout "view active" and requests workspace activation
 * from the activation coordinator. While `isActive` it activates the task view scope and
 * publishes itself as the focused task surface.
 */
export const EmbeddedTaskView = observer(function EmbeddedTaskView({
  projectId,
  taskId,
  isActive,
}: EmbeddedTaskViewProps) {
  const taskStore = getTaskStore(projectId, taskId);
  const kind = taskViewKind(taskStore, projectId);
  const composition = getTaskComposition(projectId, taskId);

  // Activation belongs to the coordinator; views never call `provisionTask` themselves.
  useEffect(
    () => getTaskActivationCoordinator().requestActivation(projectId, taskId),
    [projectId, taskId]
  );

  // A composition is re-created when the task's workspace id changes and does not exist before
  // provisioning, so the hold follows the composition instance.
  useEffect(() => composition?.retainSurfaceVisibility(), [composition]);

  useEffect(() => {
    if (!isActive) return;
    const ref = { projectId, taskId };
    setFocusedTaskSurface(ref);
    return () => clearFocusedTaskSurface(ref);
  }, [isActive, projectId, taskId]);

  const surface = useMemo<TaskSurface>(() => ({ isActive, compact: true }), [isActive]);

  // Project hydration and failure are rendered by the main panel itself; every other case
  // without a task row means the task is gone (or not registered yet).
  const projectIsLoadingOrFailed = kind === 'project-hydrating' || kind === 'project-error';
  if (!taskStore && !projectIsLoadingOrFailed) return <TaskUnavailable />;
  if (!getProjectManagerStore().projects.has(projectId)) return <TaskUnavailable />;

  // Hydration gate (same contract as the task view): nothing below may paint persisted view
  // state before the memento space has hydrated. `useTaskComposition()` throws without a
  // composition, so a ready task without one stays on the loading state.
  if ((composition && !composition.space.isHydrated) || (kind === 'ready' && !composition)) {
    return (
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-background text-foreground">
        <TaskViewLoadingState />
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <EmbeddedErrorBoundary key={`${projectId}:${taskId}`} fallback={<TaskUnavailable />}>
        <TaskSurfaceContext.Provider value={surface}>
          <TaskViewWrapper projectId={projectId} taskId={taskId}>
            <TaskScope projectId={projectId} taskId={taskId} activate={isActive}>
              <TaskMainPanel />
            </TaskScope>
          </TaskViewWrapper>
        </TaskSurfaceContext.Provider>
      </EmbeddedErrorBoundary>
    </div>
  );
});

function TaskUnavailable() {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 items-center justify-center bg-background p-4">
      <p className="text-center font-sans text-xs text-foreground-muted">
        This task is no longer available
      </p>
    </div>
  );
}

/**
 * A tile must never take the whole board down: a render failure degrades to the placeholder.
 * The parent remounts it (via `key`) for a different task.
 */
class EmbeddedErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error('Embedded task view failed to render', {
      error,
      componentStack: info.componentStack,
    });
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
