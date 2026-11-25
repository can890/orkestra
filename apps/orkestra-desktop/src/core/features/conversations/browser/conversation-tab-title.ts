import type { ConversationStore } from '@core/features/conversations/api/browser/conversation-manager';
import { conversationTitleForDisplayInTask } from '@core/features/conversations/api/browser/conversation-title-utils';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';

/**
 * Sekme etiketinde gösterilecek sohbet adı (MobX gözlemcileri içinde okunur): görevin tek
 * sohbeti varsayılan başlıktaysa görevin anlamlı adı, değilse biçimlenmiş sohbet başlığı.
 */
export function conversationTabTitle(conversation: ConversationStore): string {
  const { projectId, taskId, providerId, title } = conversation.data;
  return conversationTitleForDisplayInTask({
    providerId,
    title,
    taskName: getTaskStore(projectId, taskId)?.data.name,
    taskConversationCount: conversationRegistry.get(taskId)?.conversations.size ?? 0,
  });
}
