import { describe, expect, it } from 'vitest';
import { MAX_BOARD_TILES, type BoardTileRef } from './board-layout';
import { planSidebarDrop } from './board-sidebar-drop';

const ref = (n: number): BoardTileRef => ({ projectId: `p${n}`, taskId: `t${n}` });
const full = Array.from({ length: MAX_BOARD_TILES }, (_, i) => ref(i + 1));

describe('planSidebarDrop', () => {
  it('appends to the board and focuses the dropped tile when the Board is open', () => {
    const plan = planSidebarDrop({
      tiles: [ref(1), ref(2)],
      currentView: { kind: 'board' },
      dragged: ref(3),
    });
    expect(plan).toEqual({
      tiles: [ref(1), ref(2), ref(3)],
      navigate: false,
      focusTaskId: 't3',
      toast: undefined,
    });
  });

  it('adds the open task and the dropped task, then opens the Board', () => {
    const plan = planSidebarDrop({
      tiles: [],
      currentView: { kind: 'task', ...ref(1) },
      dragged: ref(2),
    });
    expect(plan.tiles).toEqual([ref(1), ref(2)]);
    expect(plan.navigate).toBe(true);
    expect(plan.focusTaskId).toBe('t2');
  });

  it('keeps existing tiles and does not duplicate the open task when it is already on the board', () => {
    const plan = planSidebarDrop({
      tiles: [ref(5), ref(1)],
      currentView: { kind: 'task', ...ref(1) },
      dragged: ref(2),
    });
    expect(plan.tiles).toEqual([ref(5), ref(1), ref(2)]);
    expect(plan.navigate).toBe(true);
  });

  it('only adds the dropped task from any other view', () => {
    const plan = planSidebarDrop({
      tiles: [ref(1)],
      currentView: { kind: 'other' },
      dragged: ref(2),
    });
    expect(plan.tiles).toEqual([ref(1), ref(2)]);
    expect(plan.navigate).toBe(true);
    expect(plan.focusTaskId).toBe('t2');
  });

  it('dropping the task that is open adds it once', () => {
    const plan = planSidebarDrop({
      tiles: [],
      currentView: { kind: 'task', ...ref(1) },
      dragged: ref(1),
    });
    expect(plan.tiles).toEqual([ref(1)]);
    expect(plan.navigate).toBe(true);
  });

  it('does not duplicate a task that is already on the board, only navigates and focuses', () => {
    const tiles = [ref(1), ref(2)];
    const plan = planSidebarDrop({ tiles, currentView: { kind: 'other' }, dragged: ref(2) });
    expect(plan.tiles).toBe(tiles);
    expect(plan.navigate).toBe(true);
    expect(plan.focusTaskId).toBe('t2');
    expect(plan.toast).toBeUndefined();
  });

  it('does not navigate when the task is already on the open Board', () => {
    const plan = planSidebarDrop({
      tiles: [ref(1)],
      currentView: { kind: 'board' },
      dragged: ref(1),
    });
    expect(plan.navigate).toBe(false);
  });

  it('a task already on a full board is not refused', () => {
    const plan = planSidebarDrop({
      tiles: full,
      currentView: { kind: 'other' },
      dragged: ref(3),
    });
    expect(plan.tiles).toBe(full);
    expect(plan.navigate).toBe(true);
    expect(plan.toast).toBeUndefined();
  });

  it('refuses with a toast when the board is full, without changes or navigation', () => {
    const plan = planSidebarDrop({
      tiles: full,
      currentView: { kind: 'task', ...ref(99) },
      dragged: ref(100),
    });
    expect(plan).toEqual({
      tiles: full,
      navigate: false,
      focusTaskId: undefined,
      toast: 'board-full',
    });
  });

  it('prefers the dropped task over the open one when only one slot is free', () => {
    const tiles = full.slice(0, MAX_BOARD_TILES - 1);
    const plan = planSidebarDrop({
      tiles,
      currentView: { kind: 'task', ...ref(98) },
      dragged: ref(99),
    });
    expect(plan.tiles).toEqual([...tiles, ref(99)]);
    expect(plan.navigate).toBe(true);
    expect(plan.focusTaskId).toBe('t99');
  });
});
