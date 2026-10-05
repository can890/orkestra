import { useCallback } from 'react';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import type { InitialConversationState } from '@core/features/tasks/contributions/browser/task-config/initial-conversation-section';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { log } from '@core/primitives/logging/browser/logger';
import type { NavigateFnTyped } from '@core/primitives/navigation/browser/navigation-hooks';
import { buildInitialConversation, deriveInitialStatus } from './build-create-task-params';
import type { CreateTaskState } from './use-create-task-state';

interface UseCreateTaskCallbackParams {
  selectedProjectId: string | undefined;
  state: CreateTaskState;
  initialConversation: InitialConversationState;
  navigate: NavigateFnTyped;
  onCreated: () => void;
}

export function useCreateTaskCallback({
  selectedProjectId,
  state,
  initialConversation,
  navigate,
  onCreated,
}: UseCreateTaskCallbackParams): { handleCreateTask: () => void; canCreate: boolean } {
  const canCreate = !!selectedProjectId && state.isValid;

  const handleCreateTask = useCallback(() => {
    if (!selectedProjectId) return;
    const taskManager = getTaskManagerStore(selectedProjectId);
    if (!taskManager) return;

    const id = crypto.randomUUID();
    const projectId = selectedProjectId;
    const conversation = buildInitialConversation(initialConversation);
    const orchestraSettings = initialConversation.orchestra?.selected
      ? initialConversation.orchestra.draft.settings
      : null;
    const startTask = () => {
      const created = taskManager.createTask({
        id,
        projectId,
        taskConfig: {
          version: '1',
          name: state.taskName.effectiveTaskName,
          linkedIssue: state.linkedType === 'issue' ? (state.linkedIssue ?? undefined) : undefined,
          initialStatus: deriveInitialStatus(state.linkedType, state.linkedPR),
          initialConversation: conversation,
        },
        workspaceConfig: state.workspaceConfig.resolvedConfig,
      });
      // createTask inserts the task synchronously, so the view can open right away.
      navigate(taskViewDef({ projectId, taskId: id }));
      onCreated();
      return created;
    };

    if (!conversation || !orchestraSettings) {
      void startTask().catch((e) => log.error('create task failed', e));
      return;
    }

    // Register the Orkestra conductor before its ACP session attaches; the first prompt carries the playbook.
    void (async () => {
      const client = await getConversationsClient();
      await client.orchestra.register({
        conversationId: conversation.id,
        projectId,
        taskId: id,
        settings: orchestraSettings,
      });
      const playbook = await client.orchestra.conductorContext({
        conversationId: conversation.id,
      });
      const first = conversation.initialQueue?.[0];
      if (first && playbook) {
        first.hiddenContext = [playbook, first.hiddenContext].filter(Boolean).join('\n\n');
      }
      await startTask();
    })().catch((e) => log.error('create task failed', e));
  }, [selectedProjectId, state, initialConversation, navigate, onCreated]);

  return { handleCreateTask, canCreate };
}
