import { observable, runInAction } from 'mobx';
import { describe, expect, it } from 'vitest';
import type { BoardLayoutState } from '@core/features/board/contributions/mementos';
import type { MementoHandle } from '@core/primitives/mementos/browser';
import { BoardStore } from './board-store';

function fakeHandle(initial: BoardLayoutState, ready: Promise<void>) {
  const cell = observable.box(initial, { deep: false });
  const handle = {
    get value() {
      return cell.get();
    },
    ready,
    update(next: BoardLayoutState | ((current: BoardLayoutState) => BoardLayoutState)) {
      runInAction(() => cell.set(typeof next === 'function' ? next(cell.get()) : next));
    },
  };
  return handle as unknown as MementoHandle<BoardLayoutState>;
}

const empty: BoardLayoutState = { version: '1', tiles: [] };

describe('BoardStore', () => {
  it('adds, dedupes and removes tiles through the shared handle', async () => {
    const store = new BoardStore(() => fakeHandle(empty, Promise.resolve()));
    expect(store.tiles).toEqual([]);
    store.add({ projectId: 'p', taskId: 't1' });
    await Promise.resolve();
    store.add({ projectId: 'p', taskId: 't1' });
    store.add({ projectId: 'q', taskId: 't2' });
    expect(store.tiles.map((tile) => tile.taskId)).toEqual(['t1', 't2']);
    expect(store.hasTask('t2')).toBe(true);
    store.remove('t1');
    expect(store.hasTask('t1')).toBe(false);
  });

  it('defers writes until the stored value has loaded', async () => {
    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = fakeHandle(empty, ready);
    const store = new BoardStore(() => handle);
    store.add({ projectId: 'p', taskId: 't1' });
    expect(store.tiles).toEqual([]);
    release();
    await ready;
    await Promise.resolve();
    expect(store.tiles.map((tile) => tile.taskId)).toEqual(['t1']);
  });
});

describe('BoardStore pending focus', () => {
  it('keeps a one-shot focus request until it is consumed for that task', () => {
    const store = new BoardStore(() => fakeHandle(empty, Promise.resolve()));
    store.requestFocus('t1');
    expect(store.pendingFocusTaskId).toBe('t1');
    store.consumeFocus('other');
    expect(store.pendingFocusTaskId).toBe('t1');
    store.consumeFocus('t1');
    expect(store.pendingFocusTaskId).toBeUndefined();
  });
});
