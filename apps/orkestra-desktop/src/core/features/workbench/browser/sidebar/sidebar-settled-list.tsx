import { MicroLabel, Tooltip, toast } from '@orkestra/ui/react/primitives';
import { ChevronDown, ChevronRight, Loader2, RotateCcw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { getProjectStore } from '@core/features/projects/api/browser/stores/project-selectors';
import {
  getTaskManagerStore,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import { log } from '@core/primitives/logging/browser/logger';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { isFreeChatProjectId } from '@core/primitives/projects/api';
import { cn } from '@core/primitives/styling/browser/cn';
import { SidebarMenu } from './sidebar-primitives';
import { TaskProviderIcons } from './task-provider-icons';

const SETTLED_OPEN_STORAGE_KEY = 'orkestra:sidebar-settled-open';

function loadSettledOpen(): boolean {
  try {
    const raw = window.localStorage.getItem(SETTLED_OPEN_STORAGE_KEY);
    return raw === 'true';
  } catch {
    return false;
  }
}

function saveSettledOpen(open: boolean): void {
  try {
    window.localStorage.setItem(SETTLED_OPEN_STORAGE_KEY, String(open));
  } catch {
    // localStorage erişimi kısıtlıysa sessizce yoksay
  }
}

const SettledTaskRow = observer(function SettledTaskRow({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const { navigate } = useNavigate();
  const [restoring, setRestoring] = useState(false);

  const task = getTaskStore(projectId, taskId);
  if (!task) return null;

  const project = getProjectStore(projectId);
  const projectBadge = isFreeChatProjectId(projectId) ? 'Sohbet' : (project?.name ?? 'Proje');
  const taskName = task.data.name || 'Sohbet';

  const handleRestore = async (openAfter: boolean) => {
    if (restoring) return;
    const taskManager = getTaskManagerStore(projectId);
    if (!taskManager) {
      toast.error('Görev yöneticisi hazır değil.');
      return;
    }
    setRestoring(true);
    try {
      await taskManager.restoreTask(taskId);
      if (openAfter) {
        navigate(taskViewDef({ projectId, taskId }));
      }
    } catch (error) {
      log.error('Arşivlenmiş görev geri yüklenemedi', error);
      toast.error('Görev geri yüklenemedi', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${taskName} — geri yükle ve aç`}
      onClick={() => void handleRestore(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void handleRestore(true);
        }
      }}
      className={cn(
        'group/settled flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-sm text-foreground-tertiary-muted transition-colors',
        'hover:bg-background-tertiary-1 hover:text-foreground-tertiary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        restoring && 'pointer-events-none opacity-60'
      )}
    >
      <span
        title={projectBadge}
        className="max-w-[76px] shrink-0 truncate rounded bg-background-tertiary-2/80 px-1.5 py-0.5 text-[10px] font-medium text-foreground-tertiary-passive"
      >
        {projectBadge}
      </span>
      <span className="min-w-0 flex-1 truncate text-left text-[13px]">{taskName}</span>
      <div className="flex shrink-0 items-center gap-1">
        <TaskProviderIcons task={task} maxIcons={3} />
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <button
                type="button"
                disabled={restoring}
                aria-label="Geri yükle"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleRestore(false);
                }}
                onKeyDown={(e) => e.stopPropagation()}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-foreground-tertiary-passive opacity-0 transition-all group-hover/settled:opacity-100 hover:bg-background-tertiary-2 hover:text-foreground focus-visible:opacity-100"
              >
                {restoring ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
              </button>
            }
          />
          <Tooltip.Content>Geri yükle</Tooltip.Content>
        </Tooltip.Root>
      </div>
    </div>
  );
});

/**
 * Arşivlenmiş düzenli görev ve sohbetleri ("Tamamlananlar") açılır-kapanır
 * bölüm halinde gösterir; tek tıkla geri yükleme ve açma sunar.
 */
export const SidebarSettledList = observer(function SidebarSettledList() {
  const sidebarStore = getSidebarStore();
  const entries = sidebarStore.settledEntries;
  const [storedOpen, setStoredOpen] = useState<boolean>(loadSettledOpen);

  if (entries.length === 0) {
    return null;
  }

  const autoExpanded =
    sidebarStore.statusFilter === 'settled' ||
    (sidebarStore.searchQuery.trim().length > 0 && entries.length > 0);
  const isOpen = autoExpanded || storedOpen;

  const toggleOpen = () => {
    setStoredOpen((prev) => {
      const next = !prev;
      saveSettledOpen(next);
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
          <MicroLabel className="truncate font-medium">Tamamlananlar</MicroLabel>
          <span className="shrink-0 text-[11px] font-medium text-foreground-tertiary-muted tabular-nums">
            ({entries.length})
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
            <SettledTaskRow key={`${projectId}:${taskId}`} projectId={projectId} taskId={taskId} />
          ))}
        </SidebarMenu>
      )}
    </div>
  );
});
