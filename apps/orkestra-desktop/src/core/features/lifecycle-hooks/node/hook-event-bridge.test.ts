import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@core/primitives/agents/api';
import { attachLifecycleHookSink } from './hook-event-bus';
import { installLifecycleHookEventBridge } from './hook-event-bridge';
import type { LifecycleHookEvent } from './hook-events';

const agentEvent = (overrides: Partial<AgentEvent>): AgentEvent => ({
  type: 'stop',
  projectId: 'p1',
  taskId: 't1',
  conversationId: 'c1',
  timestamp: 1000,
  payload: {},
  ...overrides,
});

describe('olay köprüsü', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  function setup() {
    const received: LifecycleHookEvent[] = [];
    cleanups.push(attachLifecycleHookSink((event) => received.push(event)));
    let agentHandler: (event: AgentEvent) => void = () => {};
    let createdHandler: (task: { id: string; projectId: string; name: string }) => void = () => {};
    let archivedHandler: (taskId: string, projectId: string) => void = () => {};
    cleanups.push(
      installLifecycleHookEventBridge({
        agentStatus: {
          on: (_name, handler) => {
            agentHandler = handler;
            return () => {};
          },
        },
        onTaskCreated: (handler) => {
          createdHandler = handler;
          return () => {};
        },
        onTaskArchived: (handler) => {
          archivedHandler = handler;
          return () => {};
        },
      })
    );
    return {
      received,
      agent: (event: AgentEvent) => agentHandler(event),
      created: (task: { id: string; projectId: string; name: string }) => createdHandler(task),
      archived: (taskId: string, projectId: string) => archivedHandler(taskId, projectId),
    };
  }

  it('stop → turn-ended (completed), error → turn-ended (error)', () => {
    const h = setup();
    h.agent(agentEvent({ type: 'stop', payload: { lastAssistantMessage: 'bitti' } }));
    h.agent(agentEvent({ type: 'error' }));
    expect(h.received.map((e) => [e.name, e.data.outcome])).toEqual([
      ['conversation.turn-ended', 'completed'],
      ['conversation.turn-ended', 'error'],
    ]);
    expect(h.received[0]?.data.lastAssistantMessage).toBe('bitti');
    expect(h.received[0]).toMatchObject({ projectId: 'p1', taskId: 't1', conversationId: 'c1' });
  });

  it('yalnızca permission_prompt bildirimi izin isteği olur', () => {
    const h = setup();
    h.agent(agentEvent({ type: 'notification', payload: { notificationType: 'idle_prompt' } }));
    h.agent(agentEvent({ type: 'notification', payload: { notificationType: 'permission_prompt' } }));
    h.agent(agentEvent({ type: 'start' }));
    expect(h.received.map((e) => e.name)).toEqual(['conversation.permission-requested']);
  });

  it('görev oluşturma ve arşivleme olaylarını yayınlar', () => {
    const h = setup();
    h.created({ id: 't9', projectId: 'p2', name: 'Yeni görev' });
    h.archived('t9', 'p2');
    expect(h.received.map((e) => [e.name, e.taskId, e.projectId])).toEqual([
      ['task.created', 't9', 'p2'],
      ['task.archived', 't9', 'p2'],
    ]);
    expect(h.received[0]?.data.taskName).toBe('Yeni görev');
  });

  it('yayıncı fırlatırsa üretici etkilenmez', () => {
    cleanups.push(
      attachLifecycleHookSink(() => {
        throw new Error('patladı');
      })
    );
    const detach = installLifecycleHookEventBridge({
      agentStatus: {
        on: (_n, handler) => {
          handler(agentEvent({ type: 'stop' }));
          return () => {};
        },
      },
      onTaskCreated: () => () => {},
      onTaskArchived: () => () => {},
    });
    detach();
  });
});
