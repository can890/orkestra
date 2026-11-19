import { observable, runInAction } from 'mobx';

export interface FocusedTaskSurfaceRef {
  readonly projectId: string;
  readonly taskId: string;
}

/**
 * The Task shown by a surface other than the navigation-owned task view (for example a board
 * tile) that the user is currently working in. Nav-only fallbacks consult it when the current
 * view is not a task view.
 */
const focusedSurface = observable.box<FocusedTaskSurfaceRef | null>(null, { deep: false });

export function setFocusedTaskSurface(ref: FocusedTaskSurfaceRef | null): void {
  runInAction(() => focusedSurface.set(ref));
}

export function getFocusedTaskSurface(): FocusedTaskSurfaceRef | null {
  return focusedSurface.get();
}

/** Clears the focused surface only if `ref` is still the current one (compare-and-clear). */
export function clearFocusedTaskSurface(ref: FocusedTaskSurfaceRef): void {
  runInAction(() => {
    if (focusedSurface.get() === ref) focusedSurface.set(null);
  });
}
