import type { AgentEvent } from '@core/primitives/agents/api';
import { emitLifecycleHookEvent } from './hook-event-bus';

type Unsubscribe = () => void;

export type LifecycleHookEventSources = Readonly<{
  /** Ajan durum servisi (`agent:event`): ACP ve TUI sohbetlerinin ortak durum geçişleri. */
  agentStatus: { on(name: 'agent:event', handler: (event: AgentEvent) => void): Unsubscribe };
  onTaskCreated(
    handler: (task: { id: string; projectId: string; name: string }) => void
  ): Unsubscribe;
  onTaskArchived(handler: (taskId: string, projectId: string) => void): Unsubscribe;
}>;

/**
 * Mevcut gözlem noktalarını kanca olaylarına çevirir. Hiçbir abonelik bir şeyi bekletmez ya da
 * fırlatmaz. `conversation.prompt-submitted` burada değil, konuşma denetleyicisinde (gönderilen
 * prompt'un geçtiği tek yerde) yayınlanır.
 */
export function installLifecycleHookEventBridge(sources: LifecycleHookEventSources): Unsubscribe {
  const offs: Unsubscribe[] = [];

  offs.push(
    sources.agentStatus.on('agent:event', (event) => {
      if (event.type === 'stop' || event.type === 'error') {
        emitLifecycleHookEvent({
          name: 'conversation.turn-ended',
          projectId: event.projectId,
          taskId: event.taskId,
          conversationId: event.conversationId,
          occurredAt: event.timestamp,
          data: {
            outcome: event.type === 'error' ? 'error' : 'completed',
            lastAssistantMessage: event.payload.lastAssistantMessage,
          },
        });
        return;
      }
      if (event.type === 'notification' && event.payload.notificationType === 'permission_prompt') {
        emitLifecycleHookEvent({
          name: 'conversation.permission-requested',
          projectId: event.projectId,
          taskId: event.taskId,
          conversationId: event.conversationId,
          occurredAt: event.timestamp,
          data: { title: event.payload.title, message: event.payload.message },
        });
      }
    })
  );

  offs.push(
    sources.onTaskCreated((task) =>
      emitLifecycleHookEvent({
        name: 'task.created',
        projectId: task.projectId,
        taskId: task.id,
        occurredAt: Date.now(),
        data: { taskName: task.name },
      })
    )
  );

  offs.push(
    sources.onTaskArchived((taskId, projectId) =>
      emitLifecycleHookEvent({
        name: 'task.archived',
        projectId,
        taskId,
        occurredAt: Date.now(),
        data: {},
      })
    )
  );

  return () => {
    for (const off of offs) off();
  };
}
