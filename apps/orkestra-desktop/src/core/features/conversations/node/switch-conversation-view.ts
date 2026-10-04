import { sessionSummarySchema } from '@orkestra/core/runtimes/acp/api/client';
import { conversationRecordsSchema } from '@orkestra/core/runtimes/conversations/api';
import {
  tuiAgentStateListSchema,
  tuiSessionListSchema,
} from '@orkestra/core/runtimes/tui-agents/api';
import { err, ok } from '@orkestra/shared';
import { z } from 'zod';
import { createConversationRegistry } from '@core/features/conversations/api/node/registry';
import { mapConversationRowToConversation } from '@core/features/conversations/api/node/utils';
import {
  configForConversationView,
  supportsConversationViewSwitch,
} from '@core/features/conversations/api/view-switch';
import { conversationConfig } from '@core/primitives/conversations/api/conversation-config';
import { appDbPokes } from '@core/services/app-db/node/pokes';
import { conversationLifecycleLock, switchingConversations } from './conversation-lifecycle-lock';
import { conversationWireEvents } from './event-host';
import { resolveConversationHostClient, type HostConversationMutationDeps } from './host-mutation';

export async function switchConversationView(
  deps: HostConversationMutationDeps,
  conversationId: string,
  type: 'pty' | 'acp'
) {
  return conversationLifecycleLock.runExclusive(conversationId, async () => {
    switchingConversations.add(conversationId);
    try {
      const { row, client, runtime } = await resolveConversationHostClient(deps, conversationId);
      if (!row.projectId || !row.taskId) throw new Error('Konuşmayı önce bir göreve ekleyin.');
      const snapshot = await client.records.state(undefined, 'list').asLiveSource().snapshot();
      const record = conversationRecordsSchema.parse(snapshot.data)[conversationId];
      if (!record) throw new Error('Konuşma kaydı bulunamadı.');
      if (!supportsConversationViewSwitch(record.provider))
        throw new Error('Bu ajan sohbet ve terminal arasında aynı oturumla geçişi desteklemiyor.');
      if (!record.providerSessionId)
        throw new Error(
          'Önce konuşmayı başlatın; kayıtlı oturum oluşunca görünümü değiştirebilirsiniz.'
        );
      const parsed = conversationConfig.safeParse(record.config);
      if (parsed.status !== 'ok') throw new Error('Konuşma ayarları okunamadı.');
      const config = configForConversationView(parsed.data, type);
      let acknowledged = record;
      if (record.type !== type) {
        // Yeniden bağlantı diğer görünümü başlatmış olabileceğinden iki çalışma biçimini de kontrol et.
        const [acp, tui, agents] = await Promise.all([
          runtime.acp.sessions.state(undefined, 'list').asLiveSource().snapshot(),
          runtime.tuiAgents.sessions.state(undefined, 'list').asLiveSource().snapshot(),
          runtime.tuiAgents.agentStates.state(undefined, 'list').asLiveSource().snapshot(),
        ]);
        const chat = z.record(z.string(), sessionSummarySchema).parse(acp.data)[conversationId];
        const terminal = tuiSessionListSchema.parse(tui.data)[conversationId];
        const agent = tuiAgentStateListSchema.parse(agents.data)[conversationId];
        if (
          (chat &&
            (chat.isGenerating ||
              chat.pendingPermissionCount > 0 ||
              chat.backgroundAgentCount > 0 ||
              chat.queuedPromptCount > 0 ||
              !['ready', 'closed'].includes(chat.lifecycle))) ||
          (terminal &&
            terminal.status !== 'exited' &&
            (terminal.status !== 'running' ||
              !agent ||
              (!['idle', 'completed'].includes(agent.status) &&
                !(agent.status === 'awaiting-input' && agent.notificationType === 'idle_prompt')) ||
              agent.notificationType === 'permission_prompt' ||
              agent.notificationType === 'elicitation_dialog'))
        ) {
          throw new Error(
            'Ajanın işi veya bekleyen izinleri bitince görünümü değiştirebilirsiniz.'
          );
        }
        // Sağlayıcının kayıtlı geçmişini koruyarak otomatik yeniden başlatma isteğini kaldır.
        const stopped =
          record.type === 'acp'
            ? await runtime.acp.terminate({ conversationId })
            : await runtime.tuiAgents.kill({ conversationId });
        if (!stopped.success)
          throw new Error(stopped.error.message ?? 'Mevcut görünüm durdurulamadı.');
        const switched = await client.switchType({
          conversationId,
          expectedType: record.type,
          expectedSessionId: record.providerSessionId,
          type,
          config,
        });
        if (!switched.success) throw new Error(switched.error.message);
        acknowledged = switched.data;
      }
      const registry = createConversationRegistry(deps.db);
      registry.refresh(conversationId, {
        type: acknowledged.type,
        config: record.type === type ? parsed.data : config,
        providerSessionId: acknowledged.providerSessionId,
        updatedAt: new Date(acknowledged.updatedAt).toISOString(),
        lastObservedAt: new Date().toISOString(),
      });
      const current = createConversationRegistry(deps.db).getLive(conversationId);
      const conversation = current && mapConversationRowToConversation(current);
      if (!conversation) throw new Error('Konuşma artık bu göreve bağlı değil.');
      conversationWireEvents.emit(undefined, {
        type: 'changed',
        conversationId,
        taskId: row.taskId,
        projectId: row.projectId,
        changes: conversation,
      });
      appDbPokes.conversations.poke({ projectId: row.projectId, taskId: row.taskId });
      return ok(conversation);
    } catch (error) {
      return err({
        type: 'view-switch-failed' as const,
        message: error instanceof Error ? error.message : 'Görünüm değiştirilemedi.',
      });
    } finally {
      switchingConversations.delete(conversationId);
    }
  });
}
