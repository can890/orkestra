import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import { log } from '@orkestra/shared/logger';
import { toast } from '@orkestra/ui/react/primitives';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { openModal } from '@core/manifests/browser/modal-api';
import { forkConversationToNewTask } from './fork-to-task';
import type { VisibleTurnLike } from './switch-provider-in-place';

/** Sohbet deposunun gösterdiği turlar (geçmiş okunamazsa yedek). */
export type HandoffSource = {
  conversationId: string;
  projectId: string;
  taskId: string;
  visibleTurns(): readonly VisibleTurnLike[];
  /** Kaynak sohbette şu an bir tur sürüyor mu (devir penceresi uyarı gösterir). */
  isWorking?(): boolean;
  permissionMode?: () => string | null;
  effort?: () => string | null;
};

/**
 * T3 Code'daki gibi tıklanan yanıta kadar olan konuşmadan soldaki kenar çubuğunda
 * aynı projede yeni bir sohbet/görev açar ve oraya geçer.
 */
export async function forkConversation(
  source: HandoffSource,
  options: { upToItemId?: string } = {}
): Promise<void> {
  const data = conversationRegistry
    .get(source.taskId)
    ?.conversations.get(source.conversationId)?.data;
  if (!data) {
    toast.error('Yeni sohbet açılamadı', { description: 'Kaynak sohbet bulunamadı.' });
    return;
  }
  try {
    await forkConversationToNewTask({
      projectId: source.projectId,
      taskId: source.taskId,
      sourceConversationId: source.conversationId,
      providerId: data.providerId,
      model: data.model,
      autoApprove: data.autoApprove,
      modeId: source.permissionMode?.() ?? data.modeId,
      effort: source.effort?.() ?? undefined,
      upToItemId: options.upToItemId,
      fallbackTurns: source.visibleTurns(),
    });
  } catch (error) {
    log.warn('[handoff] fork-to-task failed', { error });
    toast.error('Yeni sohbet açılamadı', {
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Hedef ajanı seçtiren pencereyi açar. `targetProviderId` verilirse (mesaj kutusundaki ajan
 * seçici ya da limit şeridi) o ajan önceden seçili gelir; kullanıcı yine de onaylamalıdır.
 */
export async function openHandoffDialog(
  source: HandoffSource,
  options: { targetProviderId?: AgentProviderId } = {}
): Promise<void> {
  await openModal('handoffConversationModal', {
    projectId: source.projectId,
    taskId: source.taskId,
    sourceConversationId: source.conversationId,
    fallbackTurns: source.visibleTurns(),
    ...(options.targetProviderId ? { initialProviderId: options.targetProviderId } : {}),
    sourceWorking: source.isWorking?.() ?? false,
  });
}
