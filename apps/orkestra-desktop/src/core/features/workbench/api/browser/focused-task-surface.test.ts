import { describe, expect, it } from 'vitest';
import {
  clearFocusedTaskSurface,
  getFocusedTaskSurface,
  setFocusedTaskSurface,
} from './focused-task-surface';

describe('focused task surface', () => {
  it('holds the current surface and clears it with null', () => {
    const ref = { projectId: 'p', taskId: 't' };
    setFocusedTaskSurface(ref);
    expect(getFocusedTaskSurface()).toBe(ref);
    setFocusedTaskSurface(null);
    expect(getFocusedTaskSurface()).toBeNull();
  });

  it('clears only when the given ref is still current', () => {
    const first = { projectId: 'p', taskId: 'a' };
    const second = { projectId: 'p', taskId: 'b' };
    setFocusedTaskSurface(first);
    setFocusedTaskSurface(second);
    clearFocusedTaskSurface(first);
    expect(getFocusedTaskSurface()).toBe(second);
    clearFocusedTaskSurface(second);
    expect(getFocusedTaskSurface()).toBeNull();
  });
});
