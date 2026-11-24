import type { ChatItem, PrefixTranscriptTurn, TranscriptTurn } from '@orkestra/chat-ui';
import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import { log } from '@orkestra/shared/logger';
import { toast } from '@orkestra/ui/react/primitives';
import { runInAction } from 'mobx';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { visibleConversationTitle } from '@core/features/conversations/api/browser/conversation-title-utils';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { buildHandoffSummary, type HandoffTurn } from '@core/features/conversations/api/handoff-summary';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { collectHistoryTurns, MAX_PAGES, type HistoryPageResult } from './handoff-history';
import {
  getCachedPrefixTurns,
  getHandoffStore,
  setCachedPrefixTurns,
  setPendingDraftText,
  type HandoffChainSegment,
} from './handoff-store';

export type VisibleTurnLike = HandoffTurn & {
  initiator?: TranscriptTurn['initiator'];
};

export interface InlineHandoffSegmentInput {
  segmentIndex: number;
  turns: readonly VisibleTurnLike[];
  divider: HandoffChainSegment;
}

function rewriteItemIds(item: ChatItem, prefix: string): ChatItem {
  const nextId = `${prefix}:${item.id}`;
  const raw = item as ChatItem & { parentId?: string; children?: readonly ChatItem[] };
  if (!raw.parentId && !raw.children?.length) {
    return { ...item, id: nextId } as ChatItem;
  }
  return {
    ...item,
    id: nextId,
    ...(raw.parentId ? { parentId: `${prefix}:${raw.parentId}` } : {}),
    ...(raw.children?.length
      ? { children: raw.children.map((child) => rewriteItemIds(child, prefix)) }
      : {}),
  } as ChatItem;
}

/**
 * Önceki yapay zeka segmentlerinin turlarını ve aralarındaki `handoff-divider` ayırıcılarını
 * çakışmayan benzersiz kimliklerle (ve negatif artan `seq` ile) birleştirir.
 */
export function buildInlineHandoffPrefixTurns(
  segments: readonly InlineHandoffSegmentInput[]
): PrefixTranscriptTurn[] {
  const out: PrefixTranscriptTurn[] = [];
  let cursor = 0;

  for (const segment of segments) {
    const prefix = `seg:${segment.segmentIndex}`;
    const sortedTurns = [...segment.turns].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

    for (const turn of sortedTurns) {
      const items = (turn.items as readonly ChatItem[])
        .filter((item) => item.kind !== 'handoff-divider')
        .map((item) => rewriteItemIds(item, prefix));
      if (items.length === 0) continue;
      const firstRole = (items[0] as { role?: string } | undefined)?.role;
      out.push({
        ...turn,
        initiator: turn.initiator ?? (firstRole === 'assistant' ? 'agent' : 'user'),
        id: `${prefix}:${turn.id}`,
        seq: -1_000_000 + cursor++,
        items: items as unknown as PrefixTranscriptTurn['items'],
      });
    }

    out.push({
      id: `handoff-divider:${segment.segmentIndex}:${segment.divider.conversationId}`,
      seq: -1_000_000 + cursor++,
      initiator: 'agent',
      items: [
        {
          kind: 'handoff-divider',
          id: `handoff-divider-item:${segment.segmentIndex}:${segment.divider.conversationId}`,
          fromProviderId: segment.divider.fromProviderId,
          fromLabel: segment.divider.fromModelLabel,
          toProviderId: segment.divider.toProviderId,
          toLabel: segment.divider.toModelLabel,
        },
      ],
    });
  }

  return out;
}

/**
 * Uygulama yeniden başlatıldıktan sonra önceki segment zincirinin tüm geçmişini yükleyip
 * `PrefixTranscriptTurn[]` dizisini yeniden kurar.
 */
export async function hydrateChainPrefixTurns(
  chain: readonly HandoffChainSegment[],
  loadHistoryPage: (conversationId: string, before?: number) => Promise<
    | {
        success: true;
        data: { turns: readonly TranscriptTurn[]; nextCursor: number | null; unavailable?: true };
      }
    | { success: false; error: unknown }
  >
): Promise<PrefixTranscriptTurn[]> {
  const segmentTurns = await Promise.all(
    chain.map(async (segment, index): Promise<InlineHandoffSegmentInput> => {
      const pages: (readonly TranscriptTurn[])[] = [];
      let before: number | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await loadHistoryPage(segment.conversationId, before).catch(() => null);
        if (!result || !result.success || result.data.unavailable) break;
        pages.unshift(result.data.turns);
        if (result.data.nextCursor === null) break;
        before = result.data.nextCursor;
      }
      return {
        segmentIndex: index,
        turns: pages.flat(),
        divider: segment,
      };
    })
  );
  return buildInlineHandoffPrefixTurns(segmentTurns);
}

function toHandoffTurns(turns: readonly (VisibleTurnLike | PrefixTranscriptTurn)[]): HandoffTurn[] {
  return turns
    .map((turn) => ({
      id: turn.id,
      seq: turn.seq,
      items: (turn.items as readonly ChatItem[])
        .filter((item) => item.kind !== 'handoff-divider')
        .map((item) => item as unknown as HandoffTurn['items'][number]),
    }))
    .filter((turn) => turn.items.length > 0);
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

export type SwitchProviderInPlaceOptions = {
  projectId: string;
  taskId: string;
  sourceConversationId: string;
  sourceProviderId: AgentProviderId;
  sourceModelLabel: string;
  sourceProviderLabel?: string;
  targetProviderId: AgentProviderId;
  targetModel?: string;
  targetModelLabel: string;
  targetEffort?: string;
  isEmpty: boolean;
  hasPrefixTurns: boolean;
  isWorking: boolean;
  draftText: string;
  visibleTurns(): readonly VisibleTurnLike[];
};

/**
 * Aynı sohbet içinde farklı bir yapay zekaya geçiş yapar:
 * - Sohbet gerçekten boşsa arka planda yeni sağlayıcıyla temiz sohbet açıp aynı sekmede değiştirir.
 * - Sohbette geçmiş varsa önceki mesajları + `⇄ Bağlam aktarımı` ayırıcısını üstte korur, özet
 *   bağlamını yeni sağlayıcının ilk mesajına görünmeden ekler ve aynı sekmede geçişi tamamlar.
 */
export async function switchConversationProviderInPlace(
  options: SwitchProviderInPlaceOptions
): Promise<{ conversationId: string } | null> {
  if (options.isWorking) {
    toast.warning('Önce mevcut yanıtı durdurun, sonra yapay zeka değiştirin.');
    return null;
  }

  const manager = conversationRegistry.get(options.taskId);
  const source = manager?.conversations.get(options.sourceConversationId)?.data;
  if (!manager || !source) {
    toast.error('Yapay zeka değiştirilemedi', { description: 'Sohbet kaydı bulunamadı.' });
    return null;
  }

  const handoffStore = getHandoffStore();
  const baseTitle = visibleConversationTitle(source.title);
  const newId = crypto.randomUUID();
  const client = (await getConversationsClient()).acp;

  // Durum 1: Gerçekten boş sohbet -> hiç bağlam özeti ya da ayırıcı oluşturma.
  if (options.isEmpty && !options.hasPrefixTurns) {
    if (options.draftText) {
      setPendingDraftText(newId, options.draftText);
    }
    await manager.createConversation({
      id: newId,
      projectId: options.projectId,
      taskId: options.taskId,
      provider: options.targetProviderId,
      title: source.title,
      ...(source.autoApprove !== undefined ? { autoApprove: source.autoApprove } : {}),
      ...(options.targetModel ? { model: options.targetModel } : {}),
      ...(options.targetEffort ? { effort: options.targetEffort } : {}),
      type: 'acp',
    });

    if (options.targetEffort) {
      handoffStore.put(newId, {
        version: 1,
        mode: 'inline-handoff',
        sourceConversationId: options.sourceConversationId,
        sourceTitle: baseTitle,
        context: '',
        createdAt: Date.now(),
        targetEffort: options.targetEffort,
      });
    }

    swapPaneTabInPlace(options.projectId, options.taskId, options.sourceConversationId, newId);
    void manager.deleteConversation(options.sourceConversationId).catch((error) => {
      log.warn('[inline-handoff] unused empty source delete failed', { error });
    });
    return { conversationId: newId };
  }

  // Durum 2: Geçmişi olan sohbet -> mevcut turları + önceki zinciri topla, ayırıcı ekle.
  const allVisible = options.visibleTurns();
  const currentFallbackTurns = allVisible.filter(
    (turn) =>
      !(turn.id.startsWith('seg:') || turn.id.startsWith('handoff-divider:')) &&
      !(turn.items as readonly ChatItem[]).some((item) => item.kind === 'handoff-divider')
  );

  let currentSegmentTurns: VisibleTurnLike[];
  try {
    currentSegmentTurns = (await collectHistoryTurns(
      (before) =>
        client.loadHistory({
          conversationId: options.sourceConversationId,
          limit: 100,
          ...(before === undefined ? {} : { before }),
        }) as Promise<HistoryPageResult>,
      toHandoffTurns(currentFallbackTurns)
    )) as unknown as VisibleTurnLike[];
    if (currentSegmentTurns.length === 0 && currentFallbackTurns.length > 0) {
      currentSegmentTurns = currentFallbackTurns;
    }
  } catch {
    currentSegmentTurns = currentFallbackTurns;
  }

  const existingRecord = handoffStore.get(options.sourceConversationId);
  const priorChain = existingRecord?.mode === 'inline-handoff' ? (existingRecord.chain ?? []) : [];

  const divider: HandoffChainSegment = {
    conversationId: options.sourceConversationId,
    fromProviderId: options.sourceProviderId,
    fromModelLabel: options.sourceModelLabel,
    toProviderId: options.targetProviderId,
    toModelLabel: options.targetModelLabel,
    createdAt: Date.now(),
  };

  let priorPrefixTurns: PrefixTranscriptTurn[] = [];
  if (priorChain.length > 0) {
    priorPrefixTurns =
      getCachedPrefixTurns(options.sourceConversationId)?.slice() ??
      (await hydrateChainPrefixTurns(
        priorChain,
        (convId, before) =>
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
          >
      ));
  }

  const appendedCurrentTurns = buildInlineHandoffPrefixTurns([
    {
      segmentIndex: priorChain.length,
      turns: currentSegmentTurns,
      divider,
    },
  ]);

  // Sequence numaralarını kesin olarak artan sıraya getir (-1_000_000'dan başlayarak).
  const combinedPrefixTurns: PrefixTranscriptTurn[] = [
    ...priorPrefixTurns.map((turn, idx) => ({ ...turn, seq: -1_000_000 + idx })),
    ...appendedCurrentTurns.map((turn, idx) => ({
      ...turn,
      seq: -1_000_000 + priorPrefixTurns.length + idx,
    })),
  ];

  const summary = buildHandoffSummary({
    turns: toHandoffTurns([...combinedPrefixTurns]),
    sourceTitle: baseTitle,
    sourceProviderLabel: options.sourceProviderLabel,
  });

  if (options.draftText) {
    setPendingDraftText(newId, options.draftText);
  }
  setCachedPrefixTurns(newId, combinedPrefixTurns);

  handoffStore.put(newId, {
    version: 1,
    mode: 'inline-handoff',
    sourceConversationId: options.sourceConversationId,
    sourceTitle: baseTitle,
    context: summary.text,
    contextDelivered: false,
    createdAt: Date.now(),
    chain: [...priorChain, divider],
    ...(options.targetEffort ? { targetEffort: options.targetEffort } : {}),
  });
  handoffStore.markSuperseded(options.sourceConversationId, newId);

  await manager.createConversation({
    id: newId,
    projectId: options.projectId,
    taskId: options.taskId,
    provider: options.targetProviderId,
    title: source.title,
    ...(source.autoApprove !== undefined ? { autoApprove: source.autoApprove } : {}),
    ...(options.targetModel ? { model: options.targetModel } : {}),
    ...(options.targetEffort ? { effort: options.targetEffort } : {}),
    type: 'acp',
  });

  swapPaneTabInPlace(options.projectId, options.taskId, options.sourceConversationId, newId);
  return { conversationId: newId };
}
