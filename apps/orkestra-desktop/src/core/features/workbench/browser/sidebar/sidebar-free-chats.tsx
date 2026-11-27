import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { toast } from '@orkestra/ui/react/primitives';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { nextDefaultConversationTitle } from '@core/features/conversations/api/browser/conversation-title-utils';
import { resolveQuickConversationAgent } from '@core/features/conversations/api/browser/quick-conversation';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import { log } from '@core/primitives/logging/browser/logger';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { FREE_CHAT_PROJECT_ID } from '@core/primitives/projects/api';
import { toTaskDndId } from './sidebar-dnd-ids';
import { SidebarGroup, SidebarMenu, SidebarMenuButton } from './sidebar-primitives';
import { PROJECT_INITIAL_VISIBLE_TASKS } from './sidebar-store';
import { SidebarTaskItem } from './task-item';

/**
 * Herhangi bir proje veya git deposu seçmeden doğrudan yeni sohbet başlatmaya yarayan üst buton.
 */
export const SidebarNewChatButton = observer(function SidebarNewChatButton() {
  const { navigate } = useNavigate();
  const [creating, setCreating] = useState(false);

  const handleStartFreeChat = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const [project, agent] = await Promise.all([
        getProjectManagerStore().ensureFreeChatProject(),
        resolveQuickConversationAgent(),
      ]);
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
      const createdPromise = taskManager.createTask({
        id: taskId,
        projectId: project.id,
        taskConfig: {
          version: '1',
          name: 'Yeni sohbet',
          initialConversation: {
            ...agent,
            id: crypto.randomUUID(),
            title: nextDefaultConversationTitle(agent.provider, []),
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
 *
 * Satırlar kenar çubuğunun ortak DndContext'i içinde sıralanabilir: sürükleyip bırakmak (veya
 * odaktayken Alt+Yukarı/Aşağı) sırayı kalıcı olarak değiştirir; ana alana bırakmak sohbeti yan
 * yana açar. Arama veya durum filtresi etkinken elle sıralama kapalıdır (yalnızca ana alana
 * sürükleme kalır), çünkü daraltılmış listede "bir üstü" kavramı tam listeyle örtüşmez.
 */
export const SidebarFreeChatsList = observer(function SidebarFreeChatsList() {
  const store = getSidebarStore();
  const entries = store.freeChatEntries;
  const canReorder = store.canReorderFreeChats;
  const isOpen = store.isSectionOpen('freeChats');

  if (entries.length === 0) {
    return null;
  }

  const toggleOpen = () => store.toggleSectionOpen('freeChats');
  const hasOverflow = !store.hasActiveFilter && entries.length > PROJECT_INITIAL_VISIBLE_TASKS;
  const showingAll = store.isShowingAllTasks(FREE_CHAT_PROJECT_ID);
  const visibleEntries =
    hasOverflow && !showingAll ? entries.slice(0, PROJECT_INITIAL_VISIBLE_TASKS) : entries;
  const hiddenCount = entries.length - visibleEntries.length;

  const dndIds = visibleEntries.map(({ projectId, taskId }) => toTaskDndId(projectId, taskId));

  return (
    <div className="mt-4 border-t border-white/[0.07] pt-3">
      <div className="mb-1 flex h-7 items-center justify-between px-2">
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={isOpen}
          className="group/sec flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-md py-1 text-left transition-colors"
        >
          <span className="flex min-w-0 items-center gap-2">
            <MessageSquare className="size-3.5 shrink-0 text-foreground-passive transition-colors group-hover/sec:text-foreground-muted" />
            <span className="truncate text-[11.5px] font-medium tracking-[0.01em] text-foreground-muted transition-colors group-hover/sec:text-foreground">
              Sohbetler
            </span>
            <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 py-px font-mono text-[10px] leading-tight text-foreground-passive tabular-nums">
              {entries.length}
            </span>
          </span>
          {isOpen ? (
            <ChevronDown className="size-3.5 shrink-0 text-foreground-passive opacity-70 transition-opacity group-hover/sec:opacity-100" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-foreground-passive opacity-70 transition-opacity group-hover/sec:opacity-100" />
          )}
        </button>
      </div>
      {isOpen && (
        <SortableContext items={dndIds} strategy={verticalListSortingStrategy}>
          <SidebarMenu className="flex flex-col gap-0.5 pt-0.5">
            {visibleEntries.map(({ projectId, taskId }, index) => (
              <SortableFreeChatRow
                key={`${projectId}:${taskId}`}
                projectId={projectId}
                taskId={taskId}
                canReorder={canReorder}
                isFirst={index === 0}
                isLast={index === visibleEntries.length - 1}
              />
            ))}
            {hasOverflow && (
              <button
                type="button"
                onClick={() => store.toggleShowAllTasks(FREE_CHAT_PROJECT_ID)}
                className="flex h-[28px] w-full cursor-pointer items-center gap-1.5 rounded-lg pr-2 pl-2.5 text-left text-[12px] text-foreground-tertiary-passive transition-colors hover:bg-white/[0.045] hover:text-foreground-secondary"
              >
                {showingAll ? (
                  <>
                    <ChevronUp className="size-3.5 shrink-0 opacity-70" />
                    <span>Daha az göster</span>
                  </>
                ) : (
                  <>
                    <ChevronDown className="size-3.5 shrink-0 opacity-70" />
                    <span>Daha fazla göster</span>
                    <span className="text-[11px] tabular-nums opacity-65">({hiddenCount})</span>
                  </>
                )}
              </button>
            )}
          </SidebarMenu>
        </SortableContext>
      )}
    </div>
  );
});

function SortableFreeChatRow({
  projectId,
  taskId,
  canReorder,
  isFirst,
  isLast,
}: {
  projectId: string;
  taskId: string;
  canReorder: boolean;
  isFirst: boolean;
  isLast: boolean;
}) {
  const { setNodeRef, transform, transition, isDragging, listeners } = useSortable({
    id: toTaskDndId(projectId, taskId),
    disabled: !canReorder,
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        position: 'relative',
        zIndex: isDragging ? 1 : 'auto',
      }}
      {...(canReorder ? listeners : {})}
    >
      <SidebarTaskItem
        projectId={projectId}
        taskId={taskId}
        rowVariant="pinned"
        // Sıralama açıkken ana alana sürükleme de ortak DndContext üzerinden yürür; filtre
        // etkinken sıralama kapalı olduğundan eski doğrudan sürükleme yolu kullanılır.
        enableDirectDragToMain={!canReorder}
        reorder={
          canReorder
            ? {
                canMoveUp: !isFirst,
                canMoveDown: !isLast,
                move: (delta) => getSidebarStore().moveFreeChatBy(taskId, delta),
              }
            : undefined
        }
      />
    </div>
  );
}
