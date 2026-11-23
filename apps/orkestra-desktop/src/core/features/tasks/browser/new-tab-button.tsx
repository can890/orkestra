import { Button, DropdownMenu, Tooltip } from '@orkestra/ui/react/primitives';
import { Globe, Plus, Smartphone } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import {
  asAvailableProject,
  getProjectStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { useTaskViewContext } from '@core/features/tasks/contributions/browser/task-view-context';
import { detectPlatformContext } from '@core/primitives/keybindings/api';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';

/**
 * The "+" rendered after the last tab in the tab strip when extra tool tabs
 * (browser / simulator) are open alongside a conversation.
 */
export const NewTabButton = observer(function NewTabButton() {
  const { projectId } = useTaskViewContext();
  const { pane } = usePaneContext();

  const handleOpenBrowser = () => {
    pane.open('browser', {});
  };

  // iOS Simülatör yalnızca macOS'ta ve yerel (SSH olmayan) projelerde sunulur.
  const simulatorAvailable =
    detectPlatformContext().os === 'mac' &&
    asAvailableProject(getProjectStore(projectId))?.project.type !== 'ssh';
  const handleOpenSimulator = () => {
    pane.open('simulator', {});
  };

  return (
    <DropdownMenu.Root>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <DropdownMenu.Trigger
              render={<Button size="sm" icon variant="ghost" aria-label="Yeni sekme" />}
            >
              <Plus className="size-3.5" />
            </DropdownMenu.Trigger>
          }
        />
        <Tooltip.Content>Yeni sekme</Tooltip.Content>
      </Tooltip.Root>
      <DropdownMenu.Content align="start" className="w-56">
        <DropdownMenu.Item onClick={handleOpenBrowser}>
          <Globe />
          Tarayıcı
          <BoundShortcut command="task.openBrowser" variant="keycaps" className="ml-auto" />
        </DropdownMenu.Item>
        {simulatorAvailable ? (
          <DropdownMenu.Item onClick={handleOpenSimulator}>
            <Smartphone />
            iOS Simülatör
          </DropdownMenu.Item>
        ) : null}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
});
