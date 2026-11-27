import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import { openTasksSideBySideOnBoard } from '@core/features/board/api/browser/board-actions';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { visibleConversationTitle } from '@core/features/conversations/api/browser/conversation-title-utils';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import {
  buildHandoffSummary,
  type HandoffSummary,
  type HandoffTurn,
} from '@core/features/conversations/api/handoff-summary';
import {
  getProjectStore,
  projectData,
} from '@core/features/projects/api/browser/stores/project-selectors';
import {
  asProvisioned,
  getRegisteredTaskData,
  getTaskManagerStore,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
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
  /** Yeni sohbetin modeli (çatallamada kaynağınki, devirde kullanıcının seçtiği); yoksa varsayılan. */
  model?: string | undefined;
  /** "Buradan çatalla": bu mesajı içeren turdan sonrası alınmaz. */
  upToItemId?: string | undefined;
  /** Sağlayıcıdan geçmiş okunamazsa kullanılacak, ekrandaki turlar. */
  fallbackTurns?: readonly HandoffTurn[];
  /** Özet başlığında geçen kaynak ajanın okunur adı. */
  sourceProviderLabel?: string | undefined;
};

/**
 * Kaynak sohbetten özet üretip aynı proje ve çalışma alanında sol panele yeni bir sohbet/görev
 * açar ve Panoda kaynak sohbetle yan yana yerleştirir. Kaynak sohbet değiştirilmez ve özet
 * **gönderilmez**: yeni sohbetin ilk isteminde, kullanıcı yazınca gizli bağlam olarak birlikte gider.
 */
export async function startConversationHandoff(
  options: StartHandoffOptions
): Promise<{ taskId: string; conversationId: string; summary: HandoffSummary }> {
  const manager = conversationRegistry.get(options.taskId);
  if (!manager) throw new Error('Görevin sohbetleri henüz yüklenmedi.');
  const source = manager.conversations.get(options.sourceConversationId)?.data;
  if (!source) throw new Error('Kaynak sohbet bulunamadı.');

  const workspaceId =
    asProvisioned(getTaskStore(options.projectId, options.taskId))?.workspaceId ??
    projectData(getProjectStore(options.projectId))?.repositoryWorkspaceId;
  if (!workspaceId) throw new Error('Çalışma alanı bulunamadı.');

  const taskManager = getTaskManagerStore(options.projectId);
  if (!taskManager) throw new Error('Görev yöneticisi hazır değil.');

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
  const sourceTitle = visibleConversationTitle(source.title);
  const baseTaskName =
    getRegisteredTaskData(options.projectId, options.taskId)?.name?.trim() || sourceTitle;
  const summary = buildHandoffSummary({
    turns,
    sourceTitle: baseTaskName,
    sourceProviderLabel: options.sourceProviderLabel,
    upToItemId: options.upToItemId,
  });
  if (!summary.text) throw new Error('Aktarılacak sohbet geçmişi yok.');

  const newTaskId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const fork = options.mode === 'fork';
  getHandoffStore().put(conversationId, {
    version: 1,
    mode: options.mode,
    sourceConversationId: options.sourceConversationId,
    sourceTitle: baseTaskName,
    ...(options.upToItemId ? { sourceItemId: options.upToItemId } : {}),
    context: summary.text,
    createdAt: Date.now(),
    targetTaskId: newTaskId,
  });
  try {
    await taskManager.createTask({
      id: newTaskId,
      projectId: options.projectId,
      taskConfig: {
        version: '1',
        name: handoffTitle(baseTaskName, options.mode),
        initialConversation: {
          id: conversationId,
          provider: options.providerId,
          title: handoffTitle(sourceTitle, options.mode),
          // Yetki genişlemesin: yalnızca aynı ajanla çatallamada kaynağın ayarı korunur.
          ...(fork && source.autoApprove !== undefined ? { autoApprove: source.autoApprove } : {}),
          ...(options.model ? { model: options.model } : {}),
          type: 'acp',
        },
      },
      workspaceConfig: {
        version: '2',
        git: { kind: 'none' },
        workspace: {
          kind: 'repository-instance',
          workspaceId,
        },
      },
    });
  } catch (error) {
    getHandoffStore().remove(conversationId);
    throw error;
  }
  openTasksSideBySideOnBoard(
    { projectId: options.projectId, taskId: options.taskId },
    { projectId: options.projectId, taskId: newTaskId }
  );
  return { taskId: newTaskId, conversationId, summary };
}
