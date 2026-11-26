import { Tooltip } from '@orkestra/ui/react/primitives';
import { Clock, FolderInput, LayoutGrid, Settings, Workflow } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { automationsViewDef } from '@core/features/automations/contributions/views';
import { boardViewDef } from '@core/features/board/contributions/views';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { UsageLimitsIndicator } from '@core/features/usage-limits/contributions/browser/usage-limits-indicator';
import { workflowsViewDef } from '@core/features/workflows/contributions/views';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';
import {
  isCurrentView,
  useNavigate,
  useWorkspaceSlots,
} from '@core/primitives/navigation/browser/navigation-hooks';
import { cn } from '@core/primitives/styling/browser/cn';
import { SidebarPinnedTaskList } from './pinned-task-list';
import { ProjectsGroupLabel } from './projects-group-label';
import { SidebarExternalSessionsSection } from './sidebar-external-sessions';
import { SidebarFilterBar } from './sidebar-filter-bar';
import { SidebarNewChatButton } from './sidebar-free-chats';
import {
  SidebarContainer,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
} from './sidebar-primitives';
import { SidebarSearchTrigger } from './sidebar-search-trigger';
import { SidebarSpace } from './sidebar-space';
import { SidebarVirtualList } from './sidebar-virtual-list';
import { UpdateSection } from './update-section';
import { useSidebarDrop } from './use-sidebar-drop';

export const LeftSidebar: React.FC = observer(function LeftSidebar() {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();

  const { isDragOver, onDragOver, onDragEnter, onDragLeave, onDrop } = useSidebarDrop();

  return (
    <div
      className={cn(
        // Closed = unmounted (store-driven conditional rendering), so the
        // border applies unconditionally.
        'surface-sunken relative flex h-full flex-col border-r border-border bg-(--em-surface) text-foreground-tertiary-muted transition-colors',
        isDragOver && 'bg-accent/10 ring-2 ring-inset ring-accent/50'
      )}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-background-tertiary/80 backdrop-blur-sm">
          <FolderInput className="size-8 text-foreground" />
          <span className="text-xs font-medium text-foreground">Proje eklemek için bırakın</span>
        </div>
      )}
      <SidebarSpace />
      <SidebarContainer className="min-h-0 w-full flex-1 border-r-0">
        <SidebarContent className="flex flex-col">
          <SidebarFilterBar />
          <SidebarPinnedTaskList />
          <SidebarNewChatButton />
          <SidebarGroup className="mb-0 flex min-h-0 flex-1 flex-col">
            <ProjectsGroupLabel />
            <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
              <SidebarMenu className="flex min-h-0 flex-1 flex-col">
                <SidebarVirtualList />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarExternalSessionsSection />
        </SidebarContent>
        <SidebarFooter className="px-2.5 py-2">
          <SidebarMenu className="flex flex-row items-center justify-between gap-1">
            <div className="flex min-w-0 items-center gap-1">
              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <SidebarMenuButton
                      isActive={isCurrentView(currentView, 'settings')}
                      onClick={() => navigate(settingsViewDef())}
                      aria-label="Ayarlar"
                      className="size-7 shrink-0 justify-center px-0 py-0"
                    >
                      <Settings className="size-4 shrink-0" />
                    </SidebarMenuButton>
                  }
                />
                <Tooltip.Content side="top">
                  Ayarlar
                  <BoundShortcut command="app.settings" variant="keycaps" />
                </Tooltip.Content>
              </Tooltip.Root>

              <SidebarSearchTrigger compact />

              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <SidebarMenuButton
                      isActive={isCurrentView(currentView, 'automations')}
                      onClick={() => navigate(automationsViewDef())}
                      aria-label="Otomasyonlar"
                      className="size-7 shrink-0 justify-center px-0 py-0"
                    >
                      <Clock className="size-4 shrink-0" />
                    </SidebarMenuButton>
                  }
                />
                <Tooltip.Content side="top">Otomasyonlar</Tooltip.Content>
              </Tooltip.Root>

              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <SidebarMenuButton
                      isActive={isCurrentView(currentView, 'workflows')}
                      onClick={() => navigate(workflowsViewDef())}
                      aria-label="İş akışları"
                      className="size-7 shrink-0 justify-center px-0 py-0"
                    >
                      <Workflow className="size-4 shrink-0" />
                    </SidebarMenuButton>
                  }
                />
                <Tooltip.Content side="top">İş akışları</Tooltip.Content>
              </Tooltip.Root>

              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <SidebarMenuButton
                      isActive={isCurrentView(currentView, 'board')}
                      onClick={() => navigate(boardViewDef())}
                      aria-label="Pano"
                      className="size-7 shrink-0 justify-center px-0 py-0"
                    >
                      <LayoutGrid className="size-4 shrink-0" />
                    </SidebarMenuButton>
                  }
                />
                <Tooltip.Content side="top">Pano</Tooltip.Content>
              </Tooltip.Root>

              <UsageLimitsIndicator
                compact
                trigger={
                  <SidebarMenuButton
                    isActive={false}
                    className="size-7 shrink-0 justify-center px-0 py-0 data-popup-open:bg-background-tertiary-2 data-popup-open:text-foreground-tertiary"
                  />
                }
              />
            </div>

            <UpdateSection compact />
          </SidebarMenu>
        </SidebarFooter>
      </SidebarContainer>
    </div>
  );
});
