import { describe, expect, it } from 'vitest';
import {
  addTile,
  gridShape,
  MAX_BOARD_TILES,
  neighbourAfterRemoval,
  removeTile,
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
