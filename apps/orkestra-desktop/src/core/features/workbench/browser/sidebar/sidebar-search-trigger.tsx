import { Tooltip } from '@orkestra/ui/react/primitives';
import { Search } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { getRegisteredTaskData } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';
import {
  useViewParams,
  useWorkspaceSlots,
} from '@core/primitives/navigation/browser/navigation-hooks';
import { SidebarMenuButton } from './sidebar-primitives';

export const SidebarSearchTrigger = observer(function SidebarSearchTrigger({
  compact = false,
}: {
  compact?: boolean;
} = {}) {
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

  const handleOpen = () => {
    void openCommandPalette({
      projectId: currentProjectId,
      taskId: currentTaskId,
      workspaceId: currentWorkspaceId,
    });
  };

  if (compact) {
    return (
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <SidebarMenuButton
              isActive={false}
              onClick={handleOpen}
              aria-label="Komut ve mesaj ara"
              className="size-7 shrink-0 justify-center px-0 py-0"
            >
              <Search className="size-4 shrink-0" />
            </SidebarMenuButton>
          }
        />
        <Tooltip.Content side="top">
          Komut ve mesaj ara
          <BoundShortcut command="app.commandPalette" variant="keycaps" />
        </Tooltip.Content>
      </Tooltip.Root>
    );
  }

  return (
    <SidebarMenuButton
      isActive={false}
      onClick={handleOpen}
      aria-label="Ara"
      className="w-full justify-between"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Search className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
        <span className="truncate">Komut ve mesaj ara…</span>
      </span>
      <BoundShortcut command="app.commandPalette" variant="keycaps" />
    </SidebarMenuButton>
  );
});
