import type { PaneLayoutNode } from '../../api/pane-layout';
import type { SplitSide } from './pane-drop-target';

export const splitAxis = (side: SplitSide) =>
  side === 'left' || side === 'right' ? 'horizontal' : 'vertical';
export const splitBefore = (side: SplitSide) => side === 'left' || side === 'top';

export function insertInPaneTree(
  tree: PaneLayoutNode,
  target: string,
  paneId: string,
  side: SplitSide
): PaneLayoutNode {
  const leaf: PaneLayoutNode = { kind: 'pane', paneId };
  if (tree.kind === 'pane') {
    if (tree.paneId !== target) return tree;
    return {
      kind: 'split',
      id: crypto.randomUUID(),
      axis: splitAxis(side),
      children: splitBefore(side) ? [leaf, tree] : [tree, leaf],
    };
  }
  const index = tree.children.findIndex(
    (child) => child.kind === 'pane' && child.paneId === target
  );
  if (index >= 0 && tree.axis === splitAxis(side)) {
    const children = [...tree.children];
    children.splice(splitBefore(side) ? index : index + 1, 0, leaf);
    return { ...tree, children };
  }
  return {
    ...tree,
    children: tree.children.map((child) => insertInPaneTree(child, target, paneId, side)),
  };
}

export function removeFromPaneTree(
  tree: PaneLayoutNode,
  paneId: string
): PaneLayoutNode | undefined {
  if (tree.kind === 'pane') return tree.paneId === paneId ? undefined : tree;
  const children = tree.children
    .map((child) => removeFromPaneTree(child, paneId))
    .filter((child): child is PaneLayoutNode => !!child);
  return children.length > 1 ? { ...tree, children } : children[0];
}

export function restorePaneTree(tree: PaneLayoutNode | undefined, ids: string[]): PaneLayoutNode {
  const leaves: string[] = [];
  const branches = new Set<string>();
  const valid = (node: PaneLayoutNode, depth: number): boolean => {
    if (depth > 8) return false;
    if (node.kind === 'pane') {
      leaves.push(node.paneId);
      return true;
    }
    if (branches.has(node.id) || node.children.length < 2) return false;
    branches.add(node.id);
    return node.children.every((child) => valid(child, depth + 1));
  };
  if (
    tree &&
    valid(tree, 0) &&
    leaves.length === ids.length &&
    new Set(leaves).size === ids.length &&
    ids.every((id) => leaves.includes(id))
  )
    return tree;
  const children: PaneLayoutNode[] = ids.map((paneId) => ({ kind: 'pane', paneId }));
  return children.length === 1
    ? children[0]
    : { kind: 'split', id: 'legacy', axis: 'horizontal', children };
}

export function isUnchangedSplit(
  tree: PaneLayoutNode,
  source: string,
  target: string,
  side: SplitSide
): boolean {
  if (source === target) return true;
  if (tree.kind === 'pane') return false;
  const sourceIndex = tree.children.findIndex(
    (child) => child.kind === 'pane' && child.paneId === source
  );
  const targetIndex = tree.children.findIndex(
    (child) => child.kind === 'pane' && child.paneId === target
  );
  if (tree.axis === splitAxis(side) && sourceIndex >= 0 && targetIndex >= 0) {
    return sourceIndex === targetIndex + (splitBefore(side) ? -1 : 1);
  }
  return tree.children.some((child) => isUnchangedSplit(child, source, target, side));
}

/** İç içe bölmeleri dışa doğru izleyerek istenen yöndeki komşuyu bulur. */
export function adjacentPane(
  tree: PaneLayoutNode,
  source: string,
  side: 'left' | 'right'
): string | undefined {
  const contains = (node: PaneLayoutNode): boolean =>
    node.kind === 'pane' ? node.paneId === source : node.children.some(contains);
  const edge = (node: PaneLayoutNode): string =>
    node.kind === 'pane'
      ? node.paneId
      : edge(side === 'right' ? node.children[0] : node.children[node.children.length - 1]);
  if (tree.kind === 'pane') return undefined;
  const index = tree.children.findIndex(contains);
  if (index < 0) return undefined;
  const nested = adjacentPane(tree.children[index], source, side);
  if (nested) return nested;
  const sibling =
    tree.axis === 'horizontal' ? tree.children[index + (side === 'right' ? 1 : -1)] : undefined;
  return sibling ? edge(sibling) : undefined;
}
