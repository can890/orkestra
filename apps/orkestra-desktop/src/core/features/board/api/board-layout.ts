export const MAX_BOARD_TILES = 6;

export interface BoardTileRef {
  readonly projectId: string;
  readonly taskId: string;
}

export interface BoardGridShape {
  readonly columns: number;
  readonly rows: number;
}

export type BoardDropSide = 'left' | 'right' | 'top' | 'bottom';

export type BoardSplitAxis = 'horizontal' | 'vertical';

export interface BoardDropTarget {
  readonly side: BoardDropSide;
  readonly targetTaskId?: string;
}

export type BoardLayoutNode =
  | {
      readonly kind: 'tile';
      readonly projectId: string;
      readonly taskId: string;
    }
  | {
      readonly kind: 'split';
      readonly id: string;
      readonly axis: BoardSplitAxis;
      readonly children: readonly BoardLayoutNode[];
    };

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

function nodeKey(node: BoardLayoutNode): string {
  return node.kind === 'tile'
    ? node.taskId
    : `(${node.axis}:${node.children.map(nodeKey).join(',')})`;
}

function makeSplit(axis: BoardSplitAxis, children: readonly BoardLayoutNode[]): BoardLayoutNode {
  return {
    kind: 'split',
    id: `split:${axis}:${children.map(nodeKey).join('|')}`,
    axis,
    children,
  };
}

function collapseNode(node: BoardLayoutNode | null | undefined): BoardLayoutNode | null {
  if (!node) return null;
  if (node.kind === 'tile') return node;

  const flattened: BoardLayoutNode[] = [];
  for (const rawChild of node.children) {
    const child = collapseNode(rawChild);
    if (!child) continue;
    if (child.kind === 'split' && child.axis === node.axis) {
      flattened.push(...child.children);
    } else {
      flattened.push(child);
    }
  }

  if (flattened.length === 0) return null;
  if (flattened.length === 1) return flattened[0]!;
  return makeSplit(node.axis, flattened);
}

/** Collects leaf tiles in left-to-right / top-to-bottom visual order, deduped. */
export function tilesFromLayout(node: BoardLayoutNode | null | undefined): BoardTileRef[] {
  if (!node) return [];
  const seen = new Set<string>();
  const out: BoardTileRef[] = [];
  const visit = (cur: BoardLayoutNode) => {
    if (cur.kind === 'tile') {
      if (!seen.has(cur.taskId)) {
        seen.add(cur.taskId);
        out.push({ projectId: cur.projectId, taskId: cur.taskId });
      }
      return;
    }
    cur.children.forEach(visit);
  };
  visit(node);
  return out;
}

/** Builds a clean single-axis layout tree from flat tiles. */
export function buildDefaultBoardLayout(
  tiles: readonly BoardTileRef[],
  axis: BoardSplitAxis = 'horizontal'
): BoardLayoutNode | null {
  const seen = new Set<string>();
  const leaves: BoardLayoutNode[] = [];
  for (const tile of tiles) {
    if (seen.has(tile.taskId)) continue;
    seen.add(tile.taskId);
    leaves.push({ kind: 'tile', projectId: tile.projectId, taskId: tile.taskId });
    if (leaves.length >= MAX_BOARD_TILES) break;
  }
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0]!;
  return makeSplit(axis, leaves);
}

export function rootSplitAxis(layout: BoardLayoutNode | null | undefined): BoardSplitAxis | null {
  return layout?.kind === 'split' ? layout.axis : null;
}

export function removeTileFromBoardLayout(
  layout: BoardLayoutNode | null | undefined,
  taskId: string
): BoardLayoutNode | null {
  if (!layout) return null;
  if (layout.kind === 'tile') {
    return layout.taskId === taskId ? null : layout;
  }
  const nextChildren = layout.children
    .map((child) => removeTileFromBoardLayout(child, taskId))
    .filter((child): child is BoardLayoutNode => child !== null);
  if (nextChildren.length === 0) return null;
  if (nextChildren.length === 1) return collapseNode(nextChildren[0]);
  return collapseNode(makeSplit(layout.axis, nextChildren));
}

export function normalizeBoardLayout(
  layout: BoardLayoutNode | null | undefined,
  tiles: readonly BoardTileRef[]
): BoardLayoutNode | null {
  if (tiles.length === 0) return null;
  const tileById = new Map<string, BoardTileRef>();
  for (const t of tiles) {
    if (!tileById.has(t.taskId)) tileById.set(t.taskId, t);
  }
  if (!layout) return buildDefaultBoardLayout(tiles, 'horizontal');

  const used = new Set<string>();
  const filterNode = (node: BoardLayoutNode): BoardLayoutNode | null => {
    if (node.kind === 'tile') {
      const match = tileById.get(node.taskId);
      if (!match || used.has(match.taskId)) return null;
      used.add(match.taskId);
      return { kind: 'tile', projectId: match.projectId, taskId: match.taskId };
    }
    const children = node.children
      .map(filterNode)
      .filter((c): c is BoardLayoutNode => c !== null);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0]!;
    return makeSplit(node.axis, children);
  };

  let normalized = collapseNode(filterNode(layout));
  for (const tile of tileById.values()) {
    if (used.has(tile.taskId)) continue;
    normalized = insertTileInBoardLayout(normalized, tile, { side: 'right' });
  }
  return normalized;
}

function containsTaskId(node: BoardLayoutNode, taskId: string): boolean {
  if (node.kind === 'tile') return node.taskId === taskId;
  return node.children.some((child) => containsTaskId(child, taskId));
}

function insertRelativeToTarget(
  node: BoardLayoutNode,
  leaf: BoardLayoutNode,
  targetTaskId: string,
  axis: BoardSplitAxis,
  before: boolean
): BoardLayoutNode {
  if (node.kind === 'tile') {
    if (node.taskId !== targetTaskId) return node;
    return makeSplit(axis, before ? [leaf, node] : [node, leaf]);
  }

  const nextChildren: BoardLayoutNode[] = [];
  for (const child of node.children) {
    if (child.kind === 'tile' && child.taskId === targetTaskId) {
      if (node.axis === axis) {
        if (before) {
          nextChildren.push(leaf, child);
        } else {
          nextChildren.push(child, leaf);
        }
      } else {
        nextChildren.push(makeSplit(axis, before ? [leaf, child] : [child, leaf]));
      }
      continue;
    }
    if (containsTaskId(child, targetTaskId)) {
      nextChildren.push(insertRelativeToTarget(child, leaf, targetTaskId, axis, before));
    } else {
      nextChildren.push(child);
    }
  }
  return makeSplit(node.axis, nextChildren);
}

/**
 * Belirtilen yönde (`left | right` = yan yana, `top | bottom` = alt alta) yeni karo ekler
 * veya mevcut bir karoyu hedef karonun/alanın o kenarına taşır.
 */
export function insertTileInBoardLayout(
  layout: BoardLayoutNode | null | undefined,
  ref: BoardTileRef,
  target?: BoardDropTarget
): BoardLayoutNode {
  const side = target?.side ?? 'right';
  const axis: BoardSplitAxis = side === 'left' || side === 'right' ? 'horizontal' : 'vertical';
  const before = side === 'left' || side === 'top';
  const leaf: BoardLayoutNode = { kind: 'tile', projectId: ref.projectId, taskId: ref.taskId };

  // Taşınan karo ağaçta zaten varsa önce çıkar.
  const base = removeTileFromBoardLayout(layout, ref.taskId);
  if (!base) return leaf;

  if (target?.targetTaskId && target.targetTaskId !== ref.taskId && containsTaskId(base, target.targetTaskId)) {
    return collapseNode(insertRelativeToTarget(base, leaf, target.targetTaskId, axis, before)) ?? leaf;
  }

  if (base.kind === 'split' && base.axis === axis) {
    const nextChildren = before ? [leaf, ...base.children] : [...base.children, leaf];
    return collapseNode(makeSplit(axis, nextChildren)) ?? leaf;
  }

  return collapseNode(makeSplit(axis, before ? [leaf, base] : [base, leaf])) ?? leaf;
}
