import { MicroLabel, toast } from '@orkestra/ui/react/primitives';
import { Loader2, MessageSquarePlus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { nextDefaultConversationTitle } from '@core/features/conversations/api/browser/conversation-title-utils';
import { useEffectiveProvider } from '@core/features/conversations/api/browser/use-effective-provider';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import { log } from '@core/primitives/logging/browser/logger';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { SidebarGroup, SidebarMenu, SidebarMenuButton } from './sidebar-primitives';
import { SidebarTaskItem } from './task-item';

/**
 * Herhangi bir proje veya git deposu seçmeden doğrudan yeni sohbet başlatmaya ve
 * açılmış serbest sohbetleri yönetmeye yarayan sol kenar çubuğu bölümü.
 */
export const SidebarFreeChatsSection = observer(function SidebarFreeChatsSection() {
  const { navigate } = useNavigate();
  const { providerId } = useEffectiveProvider();
  const [creating, setCreating] = useState(false);
  const entries = getSidebarStore().freeChatEntries;

  const handleStartFreeChat = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const project = await getProjectManagerStore().ensureFreeChatProject();
      if (!project || !project.repositoryWorkspaceId) {
        toast.error('Sohbet ortamı hazırlanamadı.');
        return;
      }
      const taskManager = getTaskManagerStore(project.id);
      if (!taskManager) {
        toast.error('Sohbet yöneticisi hazır değil.');
        return;
      }

      const taskId = crypto.randomUUID();
      const chosenProvider = providerId ?? 'antigravity';
      const createdPromise = taskManager.createTask({
        id: taskId,
        projectId: project.id,
        taskConfig: {
          version: '1',
          name: 'Yeni sohbet',
          initialConversation: {
            id: crypto.randomUUID(),
            provider: chosenProvider,
            title: nextDefaultConversationTitle(chosenProvider, []),
            type: 'acp',
            autoApprove: false,
          },
        },
        workspaceConfig: {
          version: '2',
          git: { kind: 'none' },
          workspace: {
            kind: 'repository-instance',
            workspaceId: project.repositoryWorkspaceId,
          },
        },
      });
      navigate(taskViewDef({ projectId: project.id, taskId }));
      void createdPromise.catch((error: unknown) => {
        log.error('Serbest sohbet başlatılamadı', error);
        toast.error('Sohbet başlatılamadı', {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      log.error('Serbest sohbet başlatılamadı', error);
      toast.error('Sohbet başlatılamadı', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <SidebarGroup className="flex shrink-0 flex-col pt-1">
      <div className="px-3 pb-1">
        <SidebarMenuButton
          type="button"
          onClick={() => void handleStartFreeChat()}
          disabled={creating}
          aria-label="Yeni sohbet"
          className="w-full justify-start gap-2 font-medium text-foreground"
        >
          {creating ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          ) : (
            <MessageSquarePlus className="h-4 w-4 shrink-0" />
          )}
          <span className="truncate">Yeni sohbet</span>
        </SidebarMenuButton>
      </div>
      {entries.length > 0 && (
        <>
          <div className="flex h-[32px] items-center justify-between pr-2.5 pl-5">
            <MicroLabel className="font-medium text-foreground-tertiary-passive">
              Sohbetler
            </MicroLabel>
          </div>
          <SidebarMenu className="px-3 pb-2">
            {entries.map(({ projectId, taskId }) => (
              <SidebarTaskItem
                key={`${projectId}:${taskId}`}
                projectId={projectId}
                taskId={taskId}
                rowVariant="pinned"
                enableDirectDragToMain
              />
            ))}
          </SidebarMenu>
        </>
      )}
    </SidebarGroup>
  );
});
