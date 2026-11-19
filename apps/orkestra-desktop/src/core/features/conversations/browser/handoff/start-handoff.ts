import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import {
  buildHandoffSummary,
  type HandoffSummary,
  type HandoffTurn,
} from '@core/features/conversations/api/handoff-summary';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { collectHistoryTurns, handoffTitle, type HistoryPageResult } from './handoff-history';
import { getHandoffStore, type HandoffMode } from './handoff-store';

const PAGE_SIZE = 100;

export type StartHandoffOptions = {
  projectId: string;
  taskId: string;
  sourceConversationId: string;
  mode: HandoffMode;
  /** Hedef sağlayıcı; çatallamada kaynakla aynıdır. */
  providerId: AgentProviderId;
  /** Yalnızca çatallamada kaynağın modeli kullanılır. */
  model?: string | undefined;
  /** "Buradan çatalla": bu mesajı içeren turdan sonrası alınmaz. */
  upToItemId?: string | undefined;
  /** Sağlayıcıdan geçmiş okunamazsa kullanılacak, ekrandaki turlar. */
  fallbackTurns?: readonly HandoffTurn[];
  providerLabel?: string | undefined;
};

/**
 * Kaynak sohbetten özet üretip aynı görevde yeni bir ACP sohbeti açar. Kaynak sohbet
 * değiştirilmez ve özet **gönderilmez**: yeni sohbetin ilk isteminde, kullanıcı yazınca gizli
 * bağlam olarak birlikte gider.
 */
export async function startConversationHandoff(
  options: StartHandoffOptions
): Promise<{ conversationId: string; summary: HandoffSummary }> {
  const manager = conversationRegistry.get(options.taskId);
  if (!manager) throw new Error('Görevin sohbetleri henüz yüklenmedi.');
  const source = manager.conversations.get(options.sourceConversationId)?.data;
  if (!source) throw new Error('Kaynak sohbet bulunamadı.');

  const client = (await getConversationsClient()).acp;
  const turns = await collectHistoryTurns(
    (before) =>
      client.loadHistory({
        conversationId: options.sourceConversationId,
        limit: PAGE_SIZE,
        ...(before === undefined ? {} : { before }),
      }) as Promise<HistoryPageResult>,
    options.fallbackTurns
  );
  const summary = buildHandoffSummary({
    turns,
    sourceTitle: source.title,
    sourceProviderLabel: options.providerLabel,
    upToItemId: options.upToItemId,
  });
  if (!summary.text) throw new Error('Aktarılacak sohbet geçmişi yok.');

  const conversationId = crypto.randomUUID();
  const fork = options.mode === 'fork';
  await manager.createConversation({
    id: conversationId,
    projectId: options.projectId,
    taskId: options.taskId,
    provider: options.providerId,
    title: handoffTitle(source.title, options.mode),
    // Yetki genişlemesin: yalnızca aynı ajanla çatallamada kaynağın ayarı korunur.
    ...(fork && source.autoApprove !== undefined ? { autoApprove: source.autoApprove } : {}),
    ...(fork && options.model ? { model: options.model } : {}),
    type: 'acp',
  });
  getHandoffStore().put(conversationId, {
    version: 1,
    mode: options.mode,
    sourceConversationId: options.sourceConversationId,
    sourceTitle: source.title,
    ...(options.upToItemId ? { sourceItemId: options.upToItemId } : {}),
    context: summary.text,
    createdAt: Date.now(),
  });
  getTaskComposition(options.projectId, options.taskId)?.paneLayout.open(
    'acp-chat',
    { conversationId },
    { preview: false }
  );
  return { conversationId, summary };
}
