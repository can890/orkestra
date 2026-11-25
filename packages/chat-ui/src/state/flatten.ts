/**
 * flatten — segment a transcript into a two-tier UnitsView.
 *
 * flattenTier() is the pure per-tier segmenter. ChatRoot calls it via two
 * tier-scoped createMemos:
 *
 *   committedUnits  — stable; recomputes only when committed() identity
 *                     changes (turn_done / prepend / seed). The framework memo
 *                     replaces the old WeakMap segmentCache.
 *   activeUnits     — recomputes per streaming tick but only over the small
 *                     activeTurn array. No O(total) work during streaming.
 *
 * The two tiers are joined into an UnitsView (virtual concat) that never
 * allocates a full array per tick. All downstream consumers use
 * UnitsView.at(i) / .length instead of direct array access.
 *
 * ── Seam gap ─────────────────────────────────────────────────────────────────
 *
 * The cross-tier boundary seam (last committed unit → first active unit) is
 * resolved by passing the last committed unit's kind as `prevKind` to
 * flattenTier when building activeUnits.
 *
 * ── Identity ─────────────────────────────────────────────────────────────────
 *
 * Segmenters must mint stable unit ids (${itemId}#${key}) so that the SolidJS
 * <For> over visible units never unnecessarily remounts rows, which would lose
 * the nodeMemo / blockMemo measure caches.
 *
 * ── Helpers ───────────────────────────────────────────────────────────────────
 *
 * flattenTier(items, ctx, segmenters, unitDefs?, prevKind?)
 *                               — pure; returns a RenderUnit[] for one tier.
 * UnitsView                     — virtual two-tier concat: .length / .at(i).
 * makeUnitsView(c, a)           — combine committedUnits + activeUnits.
 * collectUserTurnUnits(committed, units)
 *                               — absolute unit indices of the first unit of
 *                                 each committed user-message group; used by
 *                                 ChatRoot for the pinned-header overlay.
 */

import { isOrchestraSpawnNode } from '@components/rows/tools/subagent/orchestra-tool';
import { resolveSeamGap } from '@core/spacing';
import type { ItemSegmenter, Margin, RenderUnit, SegmentCtx } from '@core/units';
import { stampGroupRoles } from '@core/units';
import type {
  ActivityItem,
  ChatItem,
  ChatMessage,
  ChatThinking,
  SyntheticItem,
  ThinkingGroupItem,
  TranscriptTurn,
} from '@/model';
import type { ToolHeaderState } from './tool-header-state';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true when the item is a user-role message (boundary seam sentinel). */
function itemIsUser(item: ChatItem): boolean {
  return item.kind === 'message' && (item as ChatMessage).role === 'user';
}

function thinkingGroup(steps: readonly ChatThinking[]): ThinkingGroupItem {
  return {
    kind: 'thinking-group',
    id: `${steps[0].id}:thinking-group`,
    steps,
  };
}

function isActivityStep(item: ChatItem): item is ActivityItem['steps'][number] {
  switch (item.kind) {
    case 'thinking':
      return true;
    case 'tool-group':
      return item.children.length > 0 && item.children.every(isActivityStep);
    case 'execute-tool-call':
    case 'read-tool-call':
    case 'search-tool-call':
    case 'web-fetch-tool-call':
      return !isOrchestraSpawnNode(item) && !item.children?.length;
    default:
      return false;
  }
}

// ── ItemNode ──────────────────────────────────────────────────────────────────

/** A node in a nested tool-call render tree. */
export type ItemNode = {
  item: ChatItem;
  children: ItemNode[];
  headerState: ToolHeaderState;
};

// ── flattenTier ───────────────────────────────────────────────────────────────

/**
 * Segment one tier (committed or activeTurn) into a flat RenderUnit[].
 *
 * `prevKind` is the kind of the last unit from the preceding tier (if any).
 * It is used to resolve the gapBefore of the first unit in this tier against
 * the cross-tier boundary seam. Omit for the committed tier (it is always
 * first).
 */
export function flattenTier(
  turns: readonly TranscriptTurn[],
  ctx: SegmentCtx,
  segmenters: Record<string, ItemSegmenter>,
  unitDefs?: Record<string, { margin?: Margin }>,
  prevKind?: string
): RenderUnit[] {
  const out: RenderUnit[] = [];

  // Hoist stable per-call values so emitGroup allocates nothing per seam.
  const marginOf = (k: string) => unitDefs?.[k]?.margin;

  // Track the kind of the last emitted unit for seam resolution.
  let lastKind = prevKind;

  const emitGroup = (group: RenderUnit[], chrome: ItemSegmenter['chrome']): void => {
    stampGroupRoles(group);
    if (group.length === 0) return;

    // Copy chrome from the segmenter onto each unit (allows UnitRow to read it
    // without looking up the segmenter). The chrome value is stable (segmenter
    // is module-level, not data-dependent).
    if (chrome) {
      for (const u of group) {
        u.chrome = chrome;
      }
    }

    // Resolve the inter-group gap and assign it to the first unit of each
    // group (except the very first group overall, which gets gapBefore = 0).
    if (lastKind !== undefined) {
      group[0].gapBefore = resolveSeamGap(lastKind, group[0].kind, marginOf);
    }

    lastKind = group[group.length - 1].kind;
    out.push(...group);
  };

  for (const turn of turns) {
    // A turn is segmented in full before anything is emitted: artifact cards are de-duplicated
    // across the whole turn (see dedupeTurnArtifacts), and seams must be resolved against the
    // units that actually remain.
    const groups: SegmentedGroup[] = [];
    const segmentItem = (item: ChatItem | SyntheticItem): void => {
      const seg = segmenters[item.kind];
      if (!seg) return;
      groups.push({ item, units: seg.segment(item, ctx), chrome: seg.chrome });
    };

    const items = turn.items as readonly ChatItem[];
    const compactActivity =
      'providerId' in turn ? turn.providerId === 'codex' : ctx.compactActivity;

    for (let i = 0; i < items.length; ) {
      const item = items[i];
      if (compactActivity && isActivityStep(item)) {
        const steps: ActivityItem['steps'][number][] = [item];
        i += 1;
        while (i < items.length) {
          const next = items[i];
          if (!isActivityStep(next)) break;
          steps.push(next);
          i += 1;
        }

        // Bir komut araç grubuna dönüştüğünde açılır satırın kimliğini koru.
        const first = item.kind === 'tool-group' ? (item.children[0] ?? item) : item;
        segmentItem({ kind: 'activity', id: `${first.id}:activity`, steps });
        continue;
      }
      if (item.kind !== 'thinking') {
        segmentItem(item);
        i += 1;
        continue;
      }

      let end = i + 1;
      while (end < items.length && items[end].kind === 'thinking') end += 1;
      const steps = items.slice(i, end) as ChatThinking[];
      segmentItem(steps.length === 1 ? item : thinkingGroup(steps));
      i = end;
    }

    if (ctx.active && shouldShowWorking(items)) {
      segmentItem({ kind: 'working', id: `${turn.id}:working` });
    }

    if (!ctx.active && turn.outcome && turn.outcome.kind !== 'done') {
      segmentItem({ kind: 'turn-outcome', id: `${turn.id}:outcome`, outcome: turn.outcome });
    }

    dedupeTurnArtifacts(groups);
    for (const group of groups) emitGroup(group.units, group.chrome);
  }

  return out;
}

type SegmentedGroup = {
  item: ChatItem | SyntheticItem;
  units: RenderUnit[];
  chrome: ItemSegmenter['chrome'];
};

/** Payload of an `artifact` unit (see artifact.def.tsx); only the fields read here. */
type ArtifactUnitPayload = { itemId: string; items: readonly { uri: string }[] };

/** Unit kind that renders output files (media cards, file pills). */
const ARTIFACT_UNIT_KIND = 'artifact';

/** Same file whether written as a plain path or a `file://` URI. */
function artifactKey(uri: string): string {
  if (!/^file:\/\//i.test(uri)) return uri;
  const path = uri.replace(/^file:\/\//i, '');
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/**
 * Shows each output file once per turn. The same file often appears both in a tool call's output
 * (a path printed by a command) and in the assistant's reply of that turn; the reply is the
 * preferred place, so assistant-message cards claim their files first, then tool rows in order.
 * Files already claimed are removed from later cards, and a card left empty is dropped. Later
 * turns are independent and may show the file again.
 *
 * Runs before seam resolution so measure (gapBefore, heights) and render see the same units.
 */
function dedupeTurnArtifacts(groups: SegmentedGroup[]): void {
  const artifactGroups = groups.filter((group) =>
    group.units.some((u) => u.kind === ARTIFACT_UNIT_KIND)
  );
  if (artifactGroups.length === 0) return;

  const fromMessage = (group: SegmentedGroup) => group.item.kind === 'message';
  const ordered = [
    ...artifactGroups.filter(fromMessage),
    ...artifactGroups.filter((group) => !fromMessage(group)),
  ];
  const claimed = new Set<string>();
  for (const group of ordered) {
    group.units = group.units.flatMap((u) => {
      if (u.kind !== ARTIFACT_UNIT_KIND) return [u];
      const data = u.data as ArtifactUnitPayload;
      const items = data.items.filter((artifact) => {
        const key = artifactKey(artifact.uri);
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      });
      if (items.length === data.items.length) return [u];
      if (items.length === 0) return [];
      return [{ ...u, data: { ...data, items } }];
    });
  }
}

function shouldShowWorking(items: readonly ChatItem[]): boolean {
  return !items.some(
    (item) =>
      item.kind === 'thinking' ||
      item.kind !== 'message' ||
      (item.kind === 'message' && item.role === 'assistant')
  );
}

// ── UnitsView ─────────────────────────────────────────────────────────────────

/**
 * Virtual two-tier concatenation of committedUnits + activeUnits.
 *
 * Never allocates a combined array — .at(i) routes by offset. ChatRoot
 * creates one per frame via makeUnitsView(committedUnits(), activeUnits()).
 */
export type UnitsView = {
  readonly length: number;
  at(i: number): RenderUnit | undefined;
};

/** Combine two flat arrays into an UnitsView without allocating a concat. */
export function makeUnitsView(committed: RenderUnit[], active: RenderUnit[]): UnitsView {
  const cl = committed.length;
  return {
    length: cl + active.length,
    at(i) {
      return i < cl ? committed[i] : active[i - cl];
    },
  };
}

// ── collectUserTurnUnits ──────────────────────────────────────────────────────

/**
 * Returns the absolute unit indices of the *first unit* of each committed
 * user-message group, in ascending order.
 *
 * Used by ChatRoot to determine which user-turn to pin in the sticky overlay.
 * User messages are always in the committed tier (turn_done flushes them
 * before any activeTurn content is appended), so this is stable during
 * assistant streaming.
 *
 * Accepts the committed items array directly (no longer needs the full
 * TranscriptState) and a UnitsView for index lookup.
 */
export function collectUserTurnUnits(
  committed: readonly TranscriptTurn[],
  units: UnitsView
): number[] {
  // Build a set of itemIds for committed user messages.
  const userItemIds = new Set<string>();
  for (const turn of committed) {
    for (const item of turn.items) {
      if (itemIsUser(item)) userItemIds.add(item.id);
    }
  }

  if (userItemIds.size === 0) return [];

  // Walk the flat unit view once, recording the first unit index per group.
  const result: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < units.length; i++) {
    const u = units.at(i);
    if (u && userItemIds.has(u.itemId) && !seen.has(u.itemId)) {
      seen.add(u.itemId);
      result.push(i);
    }
  }
  return result;
}
