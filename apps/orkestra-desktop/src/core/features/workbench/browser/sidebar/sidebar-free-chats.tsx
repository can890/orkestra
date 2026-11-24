import { MicroLabel, toast } from '@orkestra/ui/react/primitives';
import { ChevronDown, ChevronRight, Loader2, MessageSquarePlus } from 'lucide-react';
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

const FREE_CHATS_OPEN_STORAGE_KEY = 'orkestra:sidebar-free-chats-open';

function loadFreeChatsOpen(): boolean {
  try {
    const raw = window.localStorage.getItem(FREE_CHATS_OPEN_STORAGE_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

function saveFreeChatsOpen(open: boolean): void {
  try {
    window.localStorage.setItem(FREE_CHATS_OPEN_STORAGE_KEY, String(open));
  } catch {
    // localStorage erişimi kısıtlıysa sessizce yoksay
  }
}

/**
 * Herhangi bir proje veya git deposu seçmeden doğrudan yeni sohbet başlatmaya yarayan üst buton.
 */
export const SidebarNewChatButton = observer(function SidebarNewChatButton() {
  const { navigate } = useNavigate();
  const { providerId } = useEffectiveProvider();
  const [creating, setCreating] = useState(false);

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
    <SidebarGroup className="mb-0 flex shrink-0 flex-col pt-1">
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
    </SidebarGroup>
  );
});

/**
 * Sabitlenmemiş serbest sohbetleri ("Sohbetler") sol kenar çubuğunun en altında açılır-kapanır
 * liste olarak gösterir. Sabitlenenler otomatik olarak üstteki sabitler listesine taşınır.
 */
export const SidebarFreeChatsList = observer(function SidebarFreeChatsList() {
  const entries = getSidebarStore().freeChatEntries;
  const [isOpen, setIsOpen] = useState<boolean>(loadFreeChatsOpen);

  if (entries.length === 0) {
    return null;
  }

  const toggleOpen = () => {
    setIsOpen((prev) => {
      const next = !prev;
      saveFreeChatsOpen(next);
      return next;
    });
  };

  return (
    <div className="mt-3 border-t border-border/50 pt-2">
      <div className="flex h-[32px] items-center justify-between px-2">
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={isOpen}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-foreground-tertiary-passive transition-colors hover:text-foreground"
        >
          <MicroLabel className="truncate font-medium">Sohbetler</MicroLabel>
          <span className="shrink-0 text-[11px] font-medium text-foreground-tertiary-muted tabular-nums">
            {entries.length}
          </span>
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
          )}
        </button>
      </div>
      {isOpen && (
        <SidebarMenu className="pt-0.5">
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
      )}
    </div>
  );
});
