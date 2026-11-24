import type { ChatItem, PrefixTranscriptTurn, TranscriptTurn } from '@orkestra/chat-ui';
import { buildForkPrefixTurns, sliceTurnsUpToItem } from './fork-to-task';
import { collectHistoryTurns, type HistoryPageResult } from './handoff-history';
import type { HandoffRecord } from './handoff-store';
import { hydrateChainPrefixTurns, type VisibleTurnLike } from './switch-provider-in-place';

export const MAX_ANCESTOR_DEPTH = 32;

export type LoadHistoryPageFn = (
  conversationId: string,
  before?: number
) => Promise<
  | {
      success: true;
      data: {
        turns: readonly TranscriptTurn[];
        nextCursor: number | null;
        unavailable?: true;
      };
    }
  | { success: false; error: unknown }
>;

export type ForkAncestorHydrationDeps = {
  getRecord: (id: string) => HandoffRecord | undefined;
  loadHistoryPage: LoadHistoryPageFn;
};

function collectItemIds(items: readonly ChatItem[], into: Set<string>): void {
  for (const item of items) {
    if (item.id) into.add(item.id);
    const children = (item as ChatItem & { children?: readonly ChatItem[] }).children;
    if (children?.length) collectItemIds(children, into);
  }
}

function rewriteItemWithPrefix(
  item: ChatItem,
  prefix: string,
  usedItemIds: Set<string>
): ChatItem {
  let nextId = `${prefix}:${item.id}`;
  let suffix = 1;
  while (usedItemIds.has(nextId)) {
    nextId = `${prefix}:${suffix++}:${item.id}`;
  }
  usedItemIds.add(nextId);

  const raw = item as ChatItem & { parentId?: string; children?: readonly ChatItem[] };
  if (!raw.parentId && !raw.children?.length) {
    return { ...item, id: nextId } as ChatItem;
  }
  return {
    ...raw,
    id: nextId,
    ...(raw.parentId ? { parentId: `${prefix}:${raw.parentId}` } : {}),
    ...(raw.children?.length
      ? {
          children: raw.children.map((child) => rewriteItemWithPrefix(child, prefix, usedItemIds)),
        }
      : {}),
  } as ChatItem;
}

function normalizePrefixSeqs(turns: readonly PrefixTranscriptTurn[]): PrefixTranscriptTurn[] {
  return turns.map((turn, idx) => ({
    ...turn,
    seq: -1_000_000 + idx,
  }));
}

function appendRawTurnsAsForkPrefix(
  existingPrefixTurns: readonly PrefixTranscriptTurn[],
  rawTurns: readonly VisibleTurnLike[]
): PrefixTranscriptTurn[] {
  if (existingPrefixTurns.length === 0) {
    return buildForkPrefixTurns(rawTurns);
  }

  const usedTurnIds = new Set<string>();
  const usedItemIds = new Set<string>();
  for (const turn of existingPrefixTurns) {
    usedTurnIds.add(turn.id);
    collectItemIds(turn.items, usedItemIds);
  }

  const convertedRaw: PrefixTranscriptTurn[] = rawTurns.map((turn, idx) => {
    const slot = existingPrefixTurns.length + idx;
    let nextTurnId = `fork:t:${slot}:${turn.id}`;
    let counter = 1;
    while (usedTurnIds.has(nextTurnId)) {
      nextTurnId = `fork:t:${slot}:${counter++}:${turn.id}`;
    }
    usedTurnIds.add(nextTurnId);

    const itemPrefix = `fork:i:${slot}`;
    return {
      id: nextTurnId,
      seq: -1_000_000 + slot,
      initiator: turn.initiator ?? 'user',
      items: (turn.items as readonly ChatItem[]).map((item) =>
        rewriteItemWithPrefix(item, itemPrefix, usedItemIds)
      ),
    };
  });

  return normalizePrefixSeqs([...existingPrefixTurns, ...convertedRaw]);
}

async function resolveRecursive(
  conversationId: string,
  deps: ForkAncestorHydrationDeps,
  visited: Set<string>,
  depth: number
): Promise<PrefixTranscriptTurn[]> {
  if (!conversationId || depth >= MAX_ANCESTOR_DEPTH || visited.has(conversationId)) {
    return [];
  }

  const record = deps.getRecord(conversationId);
  if (!record) return [];

  const nextVisited = new Set(visited);
  nextVisited.add(conversationId);

  if (record.mode === 'inline-handoff') {
    if (!record.chain?.length) return [];
    const firstSegmentId = record.chain[0]?.conversationId;
    const firstSegmentRecord = firstSegmentId ? deps.getRecord(firstSegmentId) : undefined;
    const forkAncestors =
      firstSegmentId &&
      firstSegmentRecord?.mode === 'fork' &&
      !nextVisited.has(firstSegmentId)
        ? await resolveRecursive(firstSegmentId, deps, nextVisited, depth + 1)
        : [];
    const chainTurns = await hydrateChainPrefixTurns(record.chain, deps.loadHistoryPage);
    if (forkAncestors.length === 0) return chainTurns;
    return normalizePrefixSeqs([...forkAncestors, ...chainTurns]);
  }

  if (record.mode === 'fork') {
    if (!record.sourceConversationId || nextVisited.has(record.sourceConversationId)) {
      return [];
    }

    let parentPrefix = await resolveRecursive(
      record.sourceConversationId,
      deps,
      nextVisited,
      depth + 1
    );
    if (parentPrefix.length === 0 && record.chain && record.chain.length > 0) {
      parentPrefix = await hydrateChainPrefixTurns(record.chain, deps.loadHistoryPage);
    }

    let sourceTurns: VisibleTurnLike[] = [];
    try {
      sourceTurns = (await collectHistoryTurns(
        (before) =>
          deps.loadHistoryPage(record.sourceConversationId, before) as Promise<HistoryPageResult>
      )) as unknown as VisibleTurnLike[];
    } catch {
      sourceTurns = [];
    }

    const combined: VisibleTurnLike[] = [
      ...(parentPrefix as unknown as VisibleTurnLike[]),
      ...sourceTurns,
    ];
    const sliced = sliceTurnsUpToItem(combined, record.sourceItemId);
    const parentSliceCount = Math.min(parentPrefix.length, sliced.length);
    const existingPrefixTurns = sliced.slice(0, parentSliceCount) as unknown as PrefixTranscriptTurn[];
    const rawNewTurns = sliced.slice(parentSliceCount);

    return appendRawTurnsAsForkPrefix(existingPrefixTurns, rawNewTurns);
  }

  return [];
}

/**
 * Çok katmanlı çatal (`fork`-üzerine-`fork`) ve satır içi devir (`inline-handoff`) soy
 * zincirlerini döngü korumasıyla (en fazla 32 derinlik) çözüp önek turlarını oluşturur.
 */
export async function resolveForkAncestorPrefixTurns(
  conversationId: string,
  deps: ForkAncestorHydrationDeps
): Promise<PrefixTranscriptTurn[]> {
  return resolveRecursive(conversationId, deps, new Set<string>(), 0);
}
