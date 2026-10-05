import { Button, DropdownMenu, Tooltip } from '@orkestra/ui/react/primitives';
import { Globe, MessageSquarePlus, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useTaskViewContext } from '@core/features/tasks/contributions/browser/task-view-context';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';

/**
 * The "+" rendered after the last tab in the tab strip (browser-tab idiom).
 * Opens a menu whose entries create the new tab in this pane, so in a split
 * layout it doubles as "open it here".
 */
export const NewTabButton = observer(function NewTabButton() {
  const { projectId, taskId } = useTaskViewContext();
  const { pane } = usePaneContext();
  const openCreateConversationModal = useOpenModal('createConversationModal');

  const handleCreateConversation = () => {
    void (async () => {
      const outcome = await openCreateConversationModal({ projectId, taskId });
      if (!outcome.success) return;
      const { conversationId, type } = outcome.data;
      if (type === 'acp') {
        pane.open('acp-chat', { conversationId, preview: false });
      } else {
        pane.open('conversation', { conversationId, preview: false });
      }
    })();
  };

  const handleOpenBrowser = () => {
    pane.open('browser', {});
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
        <DropdownMenu.Item onClick={handleCreateConversation}>
          <MessageSquarePlus />
          Yeni sohbet
          <BoundShortcut command="task.newConversation" variant="keycaps" className="ml-auto" />
        </DropdownMenu.Item>
        <DropdownMenu.Item onClick={handleOpenBrowser}>
          <Globe />
          Tarayıcı
          <BoundShortcut command="task.openBrowser" variant="keycaps" className="ml-auto" />
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
});
