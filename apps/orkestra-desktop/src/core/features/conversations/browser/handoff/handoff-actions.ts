import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import { log } from '@orkestra/shared/logger';
import { toast } from '@orkestra/ui/react/primitives';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import type { HandoffTurn } from '@core/features/conversations/api/handoff-summary';
import { openModal } from '@core/manifests/browser/modal-api';
import { startConversationHandoff } from './start-handoff';

/** Sohbet deposunun gösterdiği turlar (geçmiş okunamazsa yedek). */
export type HandoffSource = {
  conversationId: string;
  projectId: string;
  taskId: string;
  visibleTurns(): readonly HandoffTurn[];
  /** Kaynak sohbette şu an bir tur sürüyor mu (devir penceresi uyarı gösterir). */
  isWorking?(): boolean;
};

/** Aynı ajan ve modelle yeni bir sohbete çatallar; özet gönderilmez. */
export async function forkConversation(
  source: HandoffSource,
  options: { upToItemId?: string } = {}
): Promise<void> {
  const data = conversationRegistry
    .get(source.taskId)
    ?.conversations.get(source.conversationId)?.data;
  if (!data) {
    toast.error('Sohbet çatallanamadı', { description: 'Kaynak sohbet bulunamadı.' });
    return;
  }
  try {
    await startConversationHandoff({
      projectId: source.projectId,
      taskId: source.taskId,
      sourceConversationId: source.conversationId,
      mode: 'fork',
      providerId: data.providerId,
      model: data.model,
      upToItemId: options.upToItemId,
      fallbackTurns: source.visibleTurns(),
    });
  } catch (error) {
    log.warn('[handoff] fork failed', { error });
    toast.error('Sohbet çatallanamadı', {
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
