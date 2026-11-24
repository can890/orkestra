import type { ChatItem, PrefixTranscriptTurn, TranscriptTurn } from '@orkestra/chat-ui';
import { runInAction } from 'mobx';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { visibleConversationTitle } from '@core/features/conversations/api/browser/conversation-title-utils';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { buildHandoffSummary } from '@core/features/conversations/api/handoff-summary';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { buildForkPrefixTurns, sliceTurnsUpToItem } from '../handoff/fork-to-task';
import { composeHandoffHiddenContext } from '../handoff/handoff-continue';
import {
  collectHistoryTurns,
  handoffTitle,
  type HistoryPageResult,
} from '../handoff/handoff-history';
import {
  getCachedPrefixTurns,
  getHandoffStore,
  setCachedPrefixTurns,
  setPendingDraftText,
  type HandoffChainSegment,
  type HandoffStore,
} from '../handoff/handoff-store';
import { hydrateChainPrefixTurns, type VisibleTurnLike } from '../handoff/switch-provider-in-place';

export type BranchItemLike = {
  id?: string;
  kind?: string;
  role?: string;
  text?: string;
  children?: readonly BranchItemLike[];
};

export type BranchTurnLike = {
  id: string;
  seq?: number;
  items: readonly BranchItemLike[];
};

export type TargetTurnInfo<T extends BranchTurnLike> = {
  turnsBefore: T[];
  userPromptText: string | null;
};

export type BranchConversationFromBeforeItemOptions = {
  projectId: string;
  taskId: string;
  sourceConversationId: string;
  targetItemId: string;
  visibleTurns: readonly VisibleTurnLike[];
  autoSendPromptText?: string;
  draftText?: string;
  mode?: 'in-place' | 'new-tab';
  effort?: string | null;
  permissionMode?: string | null;
};

type LoadHistoryPage = (
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

function itemContainsId(item: BranchItemLike, targetItemId: string): boolean {
  if (item.id === targetItemId) return true;
  return item.children?.some((child) => itemContainsId(child, targetItemId)) ?? false;
}

function turnContainsItem(turn: BranchTurnLike, targetItemId: string): boolean {
  return turn.id === targetItemId || turn.items.some((item) => itemContainsId(item, targetItemId));
}

function isPrefixTurnLike(turn: VisibleTurnLike): boolean {
  if (
    turn.id.startsWith('seg:') ||
    turn.id.startsWith('fork:') ||
    turn.id.startsWith('handoff-divider:')
  ) {
    return true;
  }
  return (turn.items as readonly ChatItem[]).some((item) => item.kind === 'handoff-divider');
}

function extractUserMessageFromTurn(turn: BranchTurnLike): string | null {
  const texts = turn.items
    .filter(
      (item) =>
        item.kind === 'message' &&
        item.role === 'user' &&
        typeof item.text === 'string' &&
        item.text.trim().length > 0
    )
    .map((item) => item.text!.trim());
  if (texts.length === 0) return null;
  return texts.join('\n\n');
}

/**
 * Verilen `targetItemId` öğesini içeren turun hemen öncesindeki tüm turları döndürür.
 * Hedef öğe bulunamazsa turların tamamını korur.
 */
export function sliceTurnsBeforeItem<T extends BranchTurnLike>(
  turns: readonly T[],
  targetItemId: string
): T[] {
  if (!targetItemId) return [...turns];
  const turnIdx = turns.findIndex((turn) => turnContainsItem(turn, targetItemId));
  if (turnIdx < 0) return [...turns];
  return turns.slice(0, turnIdx);
}

/**
 * `targetItemId` öğesini içeren turdan önceki turları (`turnsBefore`) ve o turdaki
 * (veya hemen öncesindeki) kullanıcı istemi metnini (`userPromptText`) çıkarır.
 */
export function extractTargetTurnInfo<T extends BranchTurnLike>(
  turns: readonly T[],
  targetItemId: string
): TargetTurnInfo<T> {
  if (!targetItemId) {
    return { turnsBefore: [...turns], userPromptText: null };
  }
  const turnIdx = turns.findIndex((turn) => turnContainsItem(turn, targetItemId));
  if (turnIdx < 0) {
    return { turnsBefore: [...turns], userPromptText: null };
  }
  const turnsBefore = turns.slice(0, turnIdx);
  let userPromptText = extractUserMessageFromTurn(turns[turnIdx]!);
  if (!userPromptText) {
    for (let idx = turnIdx - 1; idx >= 0; idx -= 1) {
      const candidate = extractUserMessageFromTurn(turns[idx]!);
      if (candidate) {
        userPromptText = candidate;
        break;
      }
    }
  }
  return { turnsBefore, userPromptText };
}

async function hydrateForkAncestors(
  conversationId: string,
  handoffStore: HandoffStore,
  loadHistoryPage: LoadHistoryPage,
  visited = new Set<string>()
): Promise<PrefixTranscriptTurn[]> {
  if (visited.has(conversationId) || visited.size >= 10) return [];
  visited.add(conversationId);

  const record = handoffStore.get(conversationId);
  if (!record) return [];

  if (record.mode === 'inline-handoff' && record.chain?.length) {
    return hydrateChainPrefixTurns(record.chain, loadHistoryPage);
  }
  if (record.mode !== 'fork' || !record.sourceConversationId) return [];

  const ancestorPrefixTurns = await hydrateForkAncestors(
    record.sourceConversationId,
    handoffStore,
    loadHistoryPage,
    visited
  );
  const chainPrefixTurns =
    ancestorPrefixTurns.length === 0 && record.chain?.length
      ? await hydrateChainPrefixTurns(record.chain, loadHistoryPage)
      : ancestorPrefixTurns;

  const sourceTurns = (await collectHistoryTurns(
    (before) => loadHistoryPage(record.sourceConversationId, before) as Promise<HistoryPageResult>
  ).catch(() => [])) as unknown as VisibleTurnLike[];

  const combined: VisibleTurnLike[] = [
    ...(chainPrefixTurns as unknown as VisibleTurnLike[]),
    ...sourceTurns,
  ];
  const sliced = sliceTurnsUpToItem(combined, record.sourceItemId);
  return buildForkPrefixTurns(sliced);
}

function swapPaneTabInPlace(
  projectId: string,
  taskId: string,
  sourceConversationId: string,
  newConversationId: string
): void {
  const paneLayout = getTaskComposition(projectId, taskId)?.paneLayout;
  if (!paneLayout) return;

  runInAction(() => {
    const targetGroup =
      paneLayout.groups.find((group) =>
        group.pane.findSingleMountEntry('acp-chat', sourceConversationId)
      ) ??
      paneLayout.groups.find((group) => group.pane === paneLayout.focusedPane) ??
      paneLayout.groups[0];

    if (!targetGroup) return;
    const oldEntry = targetGroup.pane.findSingleMountEntry('acp-chat', sourceConversationId);
    paneLayout.setActiveGroup(targetGroup.paneId);
    paneLayout.open('acp-chat', { conversationId: newConversationId }, { preview: false });
    if (oldEntry) {
      targetGroup.pane.closeTab(oldEntry.tabId);
    }
  });
}

/**
 * Düzenleme, yeniden deneme veya geri sarma için seçilen mesajdan önceki geçmişi koruyarak
 * temiz bir ACP sohbet dalı açar; eski sohbet verileri veritabanında korunur.
 */
export async function branchConversationFromBeforeItem(
  options: BranchConversationFromBeforeItemOptions
): Promise<{ conversationId: string }> {
  const manager = conversationRegistry.get(options.taskId);
  if (!manager) throw new Error('Görevin sohbetleri henüz yüklenmedi.');
  const source = manager.conversations.get(options.sourceConversationId)?.data;
  if (!source) throw new Error('Kaynak sohbet bulunamadı.');

  const handoffStore = getHandoffStore();
  const sourceRecord = handoffStore.get(options.sourceConversationId);
  const visiblePrefixTurns = options.visibleTurns.filter(isPrefixTurnLike);
  const visibleCurrentTurns = options.visibleTurns.filter((turn) => !isPrefixTurnLike(turn));

  const client = (await getConversationsClient()).acp;
  const loadHistoryPage: LoadHistoryPage = (convId, before) =>
    client.loadHistory({
      conversationId: convId,
      limit: 100,
      ...(before === undefined ? {} : { before }),
    }) as Promise<
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

  let priorPrefixTurns: VisibleTurnLike[] = visiblePrefixTurns;
  if (priorPrefixTurns.length === 0) {
    const cached = getCachedPrefixTurns(options.sourceConversationId);
    if (cached && cached.length > 0) {
      priorPrefixTurns = cached as unknown as VisibleTurnLike[];
    } else if (sourceRecord) {
      priorPrefixTurns = (await hydrateForkAncestors(
        options.sourceConversationId,
        handoffStore,
        loadHistoryPage
      )) as unknown as VisibleTurnLike[];
    }
  }

  let currentSegmentTurns: VisibleTurnLike[];
  if (
    options.targetItemId &&
    priorPrefixTurns.some((turn) => turnContainsItem(turn, options.targetItemId))
  ) {
    currentSegmentTurns = visibleCurrentTurns;
  } else {
    try {
      currentSegmentTurns = (await collectHistoryTurns(
        (before) =>
          loadHistoryPage(options.sourceConversationId, before) as Promise<HistoryPageResult>,
        visibleCurrentTurns
      )) as unknown as VisibleTurnLike[];
      if (currentSegmentTurns.length === 0 && visibleCurrentTurns.length > 0) {
        currentSegmentTurns = visibleCurrentTurns;
      } else {
        const loadedTurnIds = new Set(currentSegmentTurns.map((turn) => turn.id));
        const missingVisible = visibleCurrentTurns.filter((turn) => !loadedTurnIds.has(turn.id));
        if (missingVisible.length > 0) {
          currentSegmentTurns = [...currentSegmentTurns, ...missingVisible];
        }
      }
    } catch {
      currentSegmentTurns = visibleCurrentTurns;
    }
  }

  const allTurns: VisibleTurnLike[] = [...priorPrefixTurns, ...currentSegmentTurns];
  const turnsBefore = sliceTurnsBeforeItem(allTurns, options.targetItemId);
  const baseTitle = visibleConversationTitle(source.title);
  const prefixTurns = turnsBefore.length > 0 ? buildForkPrefixTurns(turnsBefore) : [];
  const summary =
    turnsBefore.length > 0
      ? buildHandoffSummary({ turns: turnsBefore, sourceTitle: baseTitle })
      : null;

  const newId = crypto.randomUUID();
  const mode = options.mode ?? 'in-place';
  const autoSendText = options.autoSendPromptText;
  const hasAutoSend = typeof autoSendText === 'string' && autoSendText.trim().length > 0;
  const hiddenContext =
    hasAutoSend && summary?.text ? composeHandoffHiddenContext(summary.text, undefined) : undefined;

  const targetEffort = options.effort ?? source.effort;
  const targetModeId = options.permissionMode ?? source.modeId;
  const inheritedChain: HandoffChainSegment[] | undefined =
    sourceRecord?.chain && sourceRecord.chain.length > 0
      ? sourceRecord.chain.filter((seg) =>
          turnsBefore.some((turn) => turn.id.includes(seg.conversationId))
        )
      : undefined;

  const lastTurnBefore = turnsBefore[turnsBefore.length - 1];
  const lastTurnItemId = lastTurnBefore
    ? [...lastTurnBefore.items].reverse().find((item) => Boolean(item.id))?.id
    : undefined;
  const sourceItemId =
    lastTurnBefore && !lastTurnBefore.id.startsWith('fork:') ? lastTurnItemId : undefined;

  if (!hasAutoSend && options.draftText) {
    setPendingDraftText(newId, options.draftText);
  }

  const wroteHandoffRecord = prefixTurns.length > 0;
  if (wroteHandoffRecord) {
    setCachedPrefixTurns(newId, prefixTurns);
    handoffStore.put(newId, {
      version: 1,
      mode: 'fork',
      sourceConversationId: options.sourceConversationId,
      sourceTitle: baseTitle,
      ...(sourceItemId ? { sourceItemId } : {}),
      context: summary?.text ?? '',
      contextDelivered: hasAutoSend,
      createdAt: Date.now(),
      ...(inheritedChain && inheritedChain.length > 0 ? { chain: inheritedChain } : {}),
      ...(targetEffort ? { targetEffort } : {}),
    });
  }

  const conversationTitle = mode === 'new-tab' ? handoffTitle(baseTitle, 'fork') : source.title;

  try {
    await manager.createConversation({
      id: newId,
      projectId: options.projectId,
      taskId: options.taskId,
      provider: source.providerId,
      title: conversationTitle,
      ...(source.autoApprove !== undefined ? { autoApprove: source.autoApprove } : {}),
      ...(source.model ? { model: source.model } : {}),
      ...(targetModeId ? { modeId: targetModeId } : {}),
      ...(targetEffort ? { effort: targetEffort } : {}),
      ...(source.collaborationMode ? { collaborationMode: source.collaborationMode } : {}),
      ...(hasAutoSend
        ? {
            initialQueue: [
              {
                text: autoSendText,
                ...(hiddenContext ? { hiddenContext } : {}),
              },
            ],
          }
        : {}),
      type: 'acp',
    });
  } catch (error) {
    if (wroteHandoffRecord) {
      handoffStore.remove(newId);
    }
    throw error;
  }

  if (mode === 'in-place') {
    handoffStore.markSuperseded(options.sourceConversationId, newId);
    swapPaneTabInPlace(options.projectId, options.taskId, options.sourceConversationId, newId);
  } else {
    getTaskComposition(options.projectId, options.taskId)?.paneLayout.open(
      'acp-chat',
      { conversationId: newId },
      { preview: false }
    );
  }

  return { conversationId: newId };
}
