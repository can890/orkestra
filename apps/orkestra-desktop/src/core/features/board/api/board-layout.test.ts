import { describe, expect, it } from 'vitest';
import {
  addTile,
  buildDefaultBoardLayout,
  gridShape,
  insertTileInBoardLayout,
  MAX_BOARD_TILES,
  neighbourAfterRemoval,
  normalizeBoardLayout,
  removeTile,
  removeTileFromBoardLayout,
  tilesFromLayout,
  type BoardTileRef,
} from './board-layout';

const ref = (n: number): BoardTileRef => ({ projectId: `p${n}`, taskId: `t${n}` });

describe('addTile', () => {
  it('appends a new tile', () => {
    expect(addTile([ref(1)], ref(2))).toEqual([ref(1), ref(2)]);
  });

  it('is a no-op when the task is already on the board, even from another project', () => {
    const tiles = [ref(1)];
    expect(addTile(tiles, { projectId: 'other', taskId: 't1' })).toBe(tiles);
  });

  it('is a no-op when the board is full', () => {
    const tiles = Array.from({ length: MAX_BOARD_TILES }, (_, i) => ref(i));
    expect(addTile(tiles, ref(99))).toBe(tiles);
  });

  it('does not mutate its input', () => {
    const tiles = [ref(1)];
    addTile(tiles, ref(2));
    expect(tiles).toEqual([ref(1)]);
  });
});

describe('removeTile', () => {
  it('drops the tile with the given task id', () => {
    expect(removeTile([ref(1), ref(2), ref(3)], 't2')).toEqual([ref(1), ref(3)]);
  });

  it('returns the same array when the task is absent', () => {
    const tiles = [ref(1)];
    expect(removeTile(tiles, 'nope')).toBe(tiles);
  });
});

describe('gridShape', () => {
  it.each([
    [0, 1, 1],
    [1, 1, 1],
    [2, 2, 1],
    [3, 3, 1],
    [4, 2, 2],
    [5, 3, 2],
    [6, 3, 2],
  ])('%i tiles -> %i x %i', (count, columns, rows) => {
    expect(gridShape(count)).toEqual({ columns, rows });
  });
});

describe('neighbourAfterRemoval', () => {
  const tiles = [ref(1), ref(2), ref(3)];
  it('prefers the next tile', () => {
    expect(neighbourAfterRemoval(tiles, 't2')).toBe('t3');
  });
  it('falls back to the previous tile for the last one', () => {
    expect(neighbourAfterRemoval(tiles, 't3')).toBe('t2');
  });
  it('returns undefined for the only tile or an unknown id', () => {
    expect(neighbourAfterRemoval([ref(1)], 't1')).toBeUndefined();
    expect(neighbourAfterRemoval(tiles, 'zzz')).toBeUndefined();
  });
});

describe('BoardLayoutNode split tree algebra', () => {
  it('supports vertical stacking (top/bottom) and horizontal splitting (left/right)', () => {
    const step1 = insertTileInBoardLayout(null, ref(1));
    const stacked = insertTileInBoardLayout(step1, ref(2), { side: 'bottom' });
    expect(stacked).toMatchObject({ kind: 'split', axis: 'vertical' });
    expect(tilesFromLayout(stacked).map((t) => t.taskId)).toEqual(['t1', 't2']);

    const topInserted = insertTileInBoardLayout(stacked, ref(3), {
      side: 'top',
      targetTaskId: 't1',
    });
    expect(topInserted).toMatchObject({ kind: 'split', axis: 'vertical' });
    expect(tilesFromLayout(topInserted).map((t) => t.taskId)).toEqual(['t3', 't1', 't2']);
  });

  it('creates nested splits when dropping horizontally onto a vertically stacked tile and back', () => {
    const twoCols = buildDefaultBoardLayout([ref(1), ref(2)], 'horizontal');
    // Stack t3 below t2 -> [t1 | (t2 / t3)]
    const nested = insertTileInBoardLayout(twoCols, ref(3), {
      side: 'bottom',
      targetTaskId: 't2',
    });
    expect(nested.kind).toBe('split');
    if (nested.kind === 'split') {
      expect(nested.axis).toBe('horizontal');
      expect(nested.children[0]).toMatchObject({ kind: 'tile', taskId: 't1' });
      expect(nested.children[1]).toMatchObject({ kind: 'split', axis: 'vertical' });
    }
    expect(tilesFromLayout(nested).map((t) => t.taskId)).toEqual(['t1', 't2', 't3']);

    // Collapse cleanly when t3 is removed
    const collapsed = removeTileFromBoardLayout(nested, 't3');
    expect(collapsed).toMatchObject({ kind: 'split', axis: 'horizontal' });
    expect(tilesFromLayout(collapsed).map((t) => t.taskId)).toEqual(['t1', 't2']);
  });

  it('rearranges an existing tile when dragged onto another tile edge', () => {
    const twoCols = buildDefaultBoardLayout([ref(1), ref(2)], 'horizontal');
    const rearranged = insertTileInBoardLayout(twoCols, ref(2), {
      side: 'bottom',
      targetTaskId: 't1',
    });
    expect(rearranged).toMatchObject({ kind: 'split', axis: 'vertical' });
    expect(tilesFromLayout(rearranged).map((t) => t.taskId)).toEqual(['t1', 't2']);
  });

  it('normalizes stale layout trees against current tiles list', () => {
    const raw = buildDefaultBoardLayout([ref(1), ref(99)], 'vertical');
    const normalized = normalizeBoardLayout(raw, [ref(1), ref(2)]);
    expect(tilesFromLayout(normalized).map((t) => t.taskId)).toEqual(['t1', 't2']);
  });
});
