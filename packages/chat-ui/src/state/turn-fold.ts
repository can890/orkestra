/**
 * turn-fold — Completed-turn folding and ToolCallVisibility filtering for `@orkestra/chat-ui`.
 *
 * Adapted from T3 Code (MIT License) MessagesTimeline.logic.ts (`deriveTurnFolds`,
 * `deriveTerminalAssistantMessageIds`, `ToolCallVisibility`).
 */

import { mcpAppsOfNode } from '@components/rows/mcp-app/mcp-app-node';
import { isOrchestraSpawnNode } from '@components/rows/tools/subagent/orchestra-tool';
import { isWidgetNode } from '@components/rows/widget/widget-node';
import type { ItemSegmenter, RenderUnit, SegmentCtx } from '@core/units';
import type {
  ChatItem,
  ChatMessage,
  SyntheticItem,
  ToolCallVisibility,
  ToolNode,
  TranscriptTurn,
  TurnFoldItem,
  TurnFoldTone,
} from '@/model';

export type TurnSegmentedGroup = {
  item: ChatItem | SyntheticItem;
  units: RenderUnit[];
  chrome: ItemSegmenter['chrome'];
};

const EMPTY_SET: ReadonlySet<string> = new Set();

export function formatTurnFoldDuration(durationMs?: number): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 1000) {
    return undefined;
  }
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds} sn`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes} dk ${seconds} sn` : `${totalMinutes} dk`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} sa ${minutes} dk` : `${hours} sa`;
}

export function formatTurnFoldLabel(fold: TurnFoldItem): string {
  const duration = formatTurnFoldDuration(fold.durationMs);
  if (duration) {
    switch (fold.tone) {
      case 'stopped':
        return `${duration} sonra durduruldu`;
      case 'continued':
        return `${duration} devam etti`;
      case 'worked':
      default:
        return `${duration} çalıştı`;
    }
  }
  const parts: string[] = [];
  if (fold.intermediateMessageCount > 0) {
    parts.push(`${fold.intermediateMessageCount} ara mesaj`);
  }
  if (fold.toolStepCount > 0) {
    parts.push(`${fold.toolStepCount} araç adımı`);
  }
  if (fold.thinkingCount > 0 && parts.length === 0) {
    parts.push(`${fold.thinkingCount} düşünme adımı`);
  }
  if (parts.length > 0) return parts.join(' · ');
  return fold.tone === 'stopped' ? 'Tur durduruldu' : 'Ara adımlar';
}

export function formatTurnFoldMeta(fold: TurnFoldItem): string | undefined {
  const duration = formatTurnFoldDuration(fold.durationMs);
  if (!duration) return undefined;
  const parts: string[] = [];
  if (fold.intermediateMessageCount > 0) {
    parts.push(`${fold.intermediateMessageCount} ara mesaj`);
  }
  if (fold.toolStepCount > 0) {
    parts.push(`${fold.toolStepCount} araç`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function extractTurnDuration(
  turn: TranscriptTurn,
  items: readonly ChatItem[]
): { durationMs?: number; completedAt?: number } {
  const explicitStart = turn.startedAt;
  const explicitEnd = turn.completedAt;
  const hasExplicit =
    typeof explicitStart === 'number' &&
    typeof explicitEnd === 'number' &&
    explicitEnd > explicitStart;

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  let thinkingDurationSum = 0;

  for (const item of items) {
    if (item.kind === 'message' && typeof item.createdAt === 'number' && item.createdAt > 0) {
      if (item.createdAt < minTs) minTs = item.createdAt;
      if (item.createdAt > maxTs) maxTs = item.createdAt;
    } else if (item.kind === 'thinking') {
      if (typeof item.startedAt === 'number' && item.startedAt > 0) {
        if (item.startedAt < minTs) minTs = item.startedAt;
        const end = item.startedAt + (item.durationMs ?? 0);
        if (end > maxTs) maxTs = end;
      }
      if (typeof item.durationMs === 'number' && item.durationMs > 0) {
        thinkingDurationSum += item.durationMs;
      }
    } else if (item.kind === 'execute') {
      if (typeof item.startedAt === 'number' && item.startedAt > 0) {
        if (item.startedAt < minTs) minTs = item.startedAt;
        const end = item.startedAt + (item.durationMs ?? 0);
        if (end > maxTs) maxTs = end;
      }
    }
  }

  // Gerçek epoch-ms (2001 sonrası) tur damgaları varsa doğrudan kullan; yoksa sentetik
  // replay sayaçları (0, 1, 2…) yerine mesaj zaman damgalarını tercih et.
  const explicitIsRealEpoch =
    hasExplicit && explicitStart >= 1_000_000_000_000 && explicitEnd >= 1_000_000_000_000;
  const itemsHaveRealEpoch =
    Number.isFinite(minTs) && Number.isFinite(maxTs) && minTs >= 1_000_000_000_000;

  if (explicitIsRealEpoch) {
    return { durationMs: explicitEnd - explicitStart, completedAt: explicitEnd };
  }
  if (itemsHaveRealEpoch && maxTs > minTs) {
    return { durationMs: maxTs - minTs, completedAt: maxTs };
  }
  if (hasExplicit && !itemsHaveRealEpoch) {
    return { durationMs: explicitEnd - explicitStart, completedAt: explicitEnd };
  }
  if (Number.isFinite(minTs) && Number.isFinite(maxTs) && maxTs > minTs) {
    return { durationMs: maxTs - minTs, completedAt: maxTs };
  }
  if (thinkingDurationSum >= 1000) {
    return {
      durationMs: thinkingDurationSum,
      completedAt: Number.isFinite(maxTs) ? maxTs : undefined,
    };
  }
  return { completedAt: Number.isFinite(maxTs) ? maxTs : undefined };
}

function isUserMessage(item: ChatItem | SyntheticItem): boolean {
  return item.kind === 'message' && (item as ChatMessage).role === 'user';
}

function isAssistantMessage(item: ChatItem | SyntheticItem): item is ChatMessage {
  return item.kind === 'message' && (item as ChatMessage).role === 'assistant';
}

function isToolLikeItem(item: ChatItem | SyntheticItem): boolean {
  switch (item.kind) {
    case 'activity':
    case 'tool':
    case 'file-op':
    case 'execute':
    case 'diff':
    case 'plan':
    case 'subagent':
    case 'tool-group':
    case 'execute-tool-call':
    case 'read-tool-call':
    case 'create-file-tool-call':
    case 'modify-file-tool-call':
    case 'delete-file-tool-call':
    case 'search-tool-call':
    case 'mcp-tool-call':
    case 'web-fetch-tool-call':
    case 'spawn-subagent-tool-call':
    case 'create-plan-tool-call':
    case 'unknown-tool-call':
      return true;
    default:
      return false;
  }
}

function hasPendingPermission(
  item: ChatItem | SyntheticItem,
  pendingIds: ReadonlySet<string>
): boolean {
  if (pendingIds.size === 0) return false;
  if (pendingIds.has(item.id)) return true;
  if ('toolCallId' in item && typeof item.toolCallId === 'string' && pendingIds.has(item.toolCallId)) {
    return true;
  }
  if ('awaitingPermission' in item && item.awaitingPermission) return true;
  if (item.kind === 'tool-group') {
    return item.children.some((child) => hasPendingPermission(child, pendingIds));
  }
  if (item.kind === 'activity') {
    return item.steps.some((step) => hasPendingPermission(step, pendingIds));
  }
  return false;
}

function hasToolError(item: ChatItem | SyntheticItem): boolean {
  if ('status' in item && item.status === 'error') return true;
  if ('error' in item && Boolean(item.error)) return true;
  if (item.kind === 'tool-group') {
    return item.children.some((child) => hasToolError(child));
  }
  if (item.kind === 'activity') {
    return item.steps.some((step) => hasToolError(step));
  }
  return false;
}

function isRunningTool(item: ChatItem | SyntheticItem): boolean {
  if ('status' in item && item.status === 'running') return true;
  if (item.kind === 'subagent' && (item.phase === 'spawning' || item.phase === 'running')) {
    return true;
  }
  if (item.kind === 'tool-group') {
    return item.children.some((child) => isRunningTool(child));
  }
  if (item.kind === 'activity') {
    return item.steps.some((step) =>
      step.kind === 'thinking' ? step.status === 'thinking' : isRunningTool(step)
    );
  }
  return false;
}

function hasPersistentVisualOutput(group: TurnSegmentedGroup): boolean {
  if (
    group.units.some(
      (u) => u.kind === 'widget' || u.kind === 'mcp-app' || u.kind === 'artifact'
    )
  ) {
    return true;
  }
  const item = group.item;
  if (
    item.kind === 'handoff-divider' ||
    item.kind === 'turn-outcome' ||
    item.kind === 'working' ||
    item.kind === 'visit-watermark'
  ) {
    return true;
  }
  if (
    item.kind === 'execute-tool-call' ||
    item.kind === 'mcp-tool-call' ||
    item.kind === 'unknown-tool-call' ||
    item.kind === 'tool-group'
  ) {
    const node = item as ToolNode;
    if (isWidgetNode(node) || mcpAppsOfNode(node).length > 0) return true;
  }
  return false;
}

function hasLiveBackgroundSubagent(item: ChatItem | SyntheticItem): boolean {
  if (item.kind === 'subagent') {
    return item.phase === 'spawning' || item.phase === 'running';
  }
  if (item.kind === 'spawn-subagent-tool-call') {
    return item.status === 'running';
  }
  if (item.kind === 'tool-group') {
    return item.children.some((child) => hasLiveBackgroundSubagent(child));
  }
  if (
    item.kind === 'mcp-tool-call' ||
    item.kind === 'unknown-tool-call' ||
    item.kind === 'execute-tool-call'
  ) {
    return isOrchestraSpawnNode(item as ToolNode) && isRunningTool(item);
  }
  return false;
}

function isFoldExempt(
  group: TurnSegmentedGroup,
  terminalAssistantIdx: number,
  groupIdx: number,
  pendingIds: ReadonlySet<string>
): boolean {
  if (groupIdx === terminalAssistantIdx) return true;
  if (isUserMessage(group.item)) return true;
  if (hasPersistentVisualOutput(group)) return true;
  if (hasPendingPermission(group.item, pendingIds)) return true;
  if (hasLiveBackgroundSubagent(group.item)) return true;
  return false;
}

function findTerminalAssistantIndex(groups: readonly TurnSegmentedGroup[]): number {
  for (let i = groups.length - 1; i >= 0; i--) {
    const item = groups[i].item;
    if (isAssistantMessage(item) && item.text.trim().length > 0) {
      return i;
    }
  }
  return -1;
}

function filterGroupsByVisibility(
  groups: readonly TurnSegmentedGroup[],
  visibility: ToolCallVisibility,
  active: boolean,
  pendingIds: ReadonlySet<string>,
  revealedIds: ReadonlySet<string>,
  terminalAssistantIdx: number
): TurnSegmentedGroup[] {
  if (visibility === 'showAll') return [...groups];

  const out: TurnSegmentedGroup[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const item = group.item;

    if (
      isUserMessage(item) ||
      hasPersistentVisualOutput(group) ||
      hasPendingPermission(item, pendingIds) ||
      hasLiveBackgroundSubagent(item) ||
      revealedIds.has(item.id)
    ) {
      out.push(group);
      continue;
    }

    if (visibility === 'hideSuccessful') {
      if (isToolLikeItem(item) && !isRunningTool(item) && !hasToolError(item)) {
        continue;
      }
      out.push(group);
      continue;
    }

    if (visibility === 'hideAll') {
      if (isToolLikeItem(item) && !hasToolError(item)) {
        continue;
      }
      out.push(group);
      continue;
    }

    // visibility === 'zen'
    if (active) {
      if (hasToolError(item)) {
        out.push(group);
      }
      continue;
    }
    if (i === terminalAssistantIdx || hasToolError(item)) {
      out.push(group);
    }
  }
  return out;
}

export function applyTurnVisibilityAndFold(
  turn: TranscriptTurn,
  groups: TurnSegmentedGroup[],
  ctx: SegmentCtx,
  createTurnFoldGroup: (fold: TurnFoldItem) => TurnSegmentedGroup | null
): TurnSegmentedGroup[] {
  const visibility: ToolCallVisibility = ctx.toolCallVisibility?.() ?? 'showAll';
  const autoCollapse = ctx.autoCollapseCompletedTurns?.() ?? false;
  const pendingIds = ctx.pendingToolCallIds();
  const revealedIds = ctx.revealedItemIds?.() ?? EMPTY_SET;

  if (ctx.active) {
    return filterGroupsByVisibility(groups, visibility, true, pendingIds, revealedIds, -1);
  }

  const outcomeKind = turn.outcome?.kind;
  const isFailedOrInterrupted = outcomeKind === 'error' || outcomeKind === 'interrupted';
  const terminalIdx = findTerminalAssistantIndex(groups);

  if (!autoCollapse && visibility !== 'zen') {
    return filterGroupsByVisibility(groups, visibility, false, pendingIds, revealedIds, terminalIdx);
  }

  if (isFailedOrInterrupted) {
    return filterGroupsByVisibility(
      groups,
      visibility === 'zen' ? 'showAll' : visibility,
      false,
      pendingIds,
      revealedIds,
      terminalIdx
    );
  }

  const foldLimitIdx = terminalIdx >= 0 ? terminalIdx : groups.length;
  const foldableIndices = new Set<number>();
  let intermediateMessageCount = 0;
  let toolStepCount = 0;
  let thinkingCount = 0;
  let hasRevealedInsideFold = false;

  for (let i = 0; i < foldLimitIdx; i++) {
    const group = groups[i];
    if (isFoldExempt(group, terminalIdx, i, pendingIds)) continue;
    foldableIndices.add(i);
    if (revealedIds.has(group.item.id)) {
      hasRevealedInsideFold = true;
    }
    if (isAssistantMessage(group.item)) {
      intermediateMessageCount += 1;
    } else if (group.item.kind === 'thinking' || group.item.kind === 'thinking-group') {
      thinkingCount += 1;
    } else if (isToolLikeItem(group.item)) {
      toolStepCount += 1;
    }
  }

  if (foldableIndices.size === 0) {
    return filterGroupsByVisibility(groups, visibility, false, pendingIds, revealedIds, terminalIdx);
  }

  const foldId = `${turn.id}:fold`;
  const userExpanded = ctx.turnFoldExpanded?.(foldId) ?? false;
  const expanded = userExpanded || hasRevealedInsideFold;

  const { durationMs, completedAt } = extractTurnDuration(
    turn,
    turn.items as readonly ChatItem[]
  );
  const tone: TurnFoldTone = outcomeKind === 'cancelled' ? 'stopped' : 'worked';

  const foldItem: TurnFoldItem = {
    kind: 'turn-fold',
    id: foldId,
    turnId: turn.id,
    tone,
    durationMs,
    intermediateMessageCount,
    toolStepCount,
    thinkingCount,
    expanded,
    completedAt,
  };

  const foldGroup = createTurnFoldGroup(foldItem);
  if (!foldGroup) return groups;

  const result: TurnSegmentedGroup[] = [];
  let foldInserted = false;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (foldableIndices.has(i)) {
      if (!foldInserted) {
        result.push(foldGroup);
        foldInserted = true;
      }
      if (expanded) {
        if (
          (visibility === 'hideSuccessful' || visibility === 'hideAll') &&
          isToolLikeItem(group.item) &&
          !hasToolError(group.item)
        ) {
          continue;
        }
        result.push(group);
      }
      continue;
    }
    result.push(group);
  }

  return result;
}
