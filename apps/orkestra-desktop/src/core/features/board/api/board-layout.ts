export const MAX_BOARD_TILES = 6;

export interface BoardTileRef {
  readonly projectId: string;
  readonly taskId: string;
}

export interface BoardGridShape {
  readonly columns: number;
  readonly rows: number;
}

/** Appends a tile; a no-op when the task is already on the board or the board is full. */
export function addTile(
  tiles: readonly BoardTileRef[],
  ref: BoardTileRef
): readonly BoardTileRef[] {
  if (tiles.length >= MAX_BOARD_TILES) return tiles;
  if (tiles.some((tile) => tile.taskId === ref.taskId)) return tiles;
  return [...tiles, { projectId: ref.projectId, taskId: ref.taskId }];
}

export function removeTile(
  tiles: readonly BoardTileRef[],
  taskId: string
): readonly BoardTileRef[] {
  if (!tiles.some((tile) => tile.taskId === taskId)) return tiles;
  return tiles.filter((tile) => tile.taskId !== taskId);
}

export function gridShape(count: number): BoardGridShape {
  if (count <= 1) return { columns: 1, rows: 1 };
  if (count === 2) return { columns: 2, rows: 1 };
  if (count === 3) return { columns: 3, rows: 1 };
  if (count === 4) return { columns: 2, rows: 2 };
  return { columns: 3, rows: 2 };
}

/**
 * Picks the tile that should take focus after `removedTaskId` leaves `before`:
 * the next neighbour, otherwise the previous one, otherwise nothing.
 */
export function neighbourAfterRemoval(
  before: readonly BoardTileRef[],
  removedTaskId: string
): string | undefined {
  const index = before.findIndex((tile) => tile.taskId === removedTaskId);
  if (index === -1) return undefined;
  return (before[index + 1] ?? before[index - 1])?.taskId;
}
