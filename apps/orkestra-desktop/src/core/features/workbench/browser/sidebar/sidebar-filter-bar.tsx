import { Tooltip } from '@orkestra/ui/react/primitives';
import { MessageSquareText, Search, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { getRegisteredTaskData } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import {
  useViewParams,
  useWorkspaceSlots,
} from '@core/primitives/navigation/browser/navigation-hooks';
import { cn } from '@core/primitives/styling/browser/cn';
import type { SidebarStatusFilter } from './sidebar-store';

const STATUS_FILTERS: readonly { id: SidebarStatusFilter; label: string }[] = [
  { id: 'all', label: 'Tümü' },
  { id: 'active', label: 'Aktif' },
  { id: 'settled', label: 'Biten' },
];

/**
 * Sol kenar çubuğunun üst kısmında yer alan anlık metin arama girişi ve
 * durum filtresi (`Tümü` / `Aktif` / `Tamamlanan`) çubuğu.
 */
export const SidebarFilterBar = observer(function SidebarFilterBar() {
  const sidebarStore = getSidebarStore();
  const openCommandPalette = useOpenModal('commandPaletteModal');
  const { currentView } = useWorkspaceSlots();
  const taskParams = useViewParams(taskViewDef);
  const projectParams = useViewParams(projectViewDef);

  const currentProjectId =
    currentView === 'task'
      ? taskParams?.projectId
      : currentView === 'project'
        ? projectParams?.projectId
        : undefined;
  const currentTaskId = currentView === 'task' ? taskParams?.taskId : undefined;
  const currentWorkspaceId =
    currentProjectId && currentTaskId
      ? getRegisteredTaskData(currentProjectId, currentTaskId)?.workspaceId
      : undefined;

  const openFullMessageSearch = () => {
    const trimmed = sidebarStore.searchQuery.trim();
    void openCommandPalette({
      projectId: currentProjectId,
      taskId: currentTaskId,
      workspaceId: currentWorkspaceId,
      initialQuery: trimmed ? `@messages ${trimmed}` : '@messages ',
    });
  };

  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-3 pb-1.5">
      <div className="focus-within:border-ring/60 flex h-7 items-center rounded-md border border-border/60 bg-background-tertiary-1/60 px-2 transition-colors focus-within:bg-background-tertiary-1">
        <Search className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary-passive" />
        <input
          type="text"
          value={sidebarStore.searchQuery}
          onChange={(e) => sidebarStore.setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && sidebarStore.searchQuery) {
              e.stopPropagation();
              sidebarStore.setSearchQuery('');
            }
          }}
          placeholder="Sohbet veya proje filtrele…"
          aria-label="Sohbet veya proje filtrele"
          className="min-w-0 flex-1 bg-transparent px-1.5 text-xs text-foreground outline-none placeholder:text-foreground-tertiary-passive"
        />
        {sidebarStore.searchQuery.length > 0 && (
          <button
            type="button"
            onClick={() => sidebarStore.setSearchQuery('')}
            aria-label="Filtreyi temizle"
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-foreground-tertiary-passive transition-colors hover:bg-background-tertiary-2 hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <button
                type="button"
                onClick={openFullMessageSearch}
                aria-label="Tüm mesajlarda ara"
                className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-foreground-tertiary-passive transition-colors hover:bg-background-tertiary-2 hover:text-foreground"
              >
                <MessageSquareText className="h-3.5 w-3.5" />
              </button>
            }
          />
          <Tooltip.Content>Mesajlarda ve komutlarda ara (⌘K)</Tooltip.Content>
        </Tooltip.Root>
      </div>

      <div
        role="group"
        aria-label="Sohbet durumu filtresi"
        className="grid grid-cols-3 gap-0.5 rounded-md border border-border/40 bg-background-tertiary-1/50 p-0.5"
      >
        {STATUS_FILTERS.map((option) => {
          const isActive = sidebarStore.statusFilter === option.id;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={isActive}
              onClick={() => sidebarStore.setStatusFilter(option.id)}
              className={cn(
                'h-5 truncate rounded-[5px] px-1.5 text-[11px] transition-colors',
                isActive
                  ? 'bg-background-tertiary-2 font-medium text-foreground shadow-xs'
                  : 'text-foreground-tertiary-muted hover:text-foreground'
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
});
