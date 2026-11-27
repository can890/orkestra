import { FileSearch, Globe, Loader2, MessageSquare } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState, type ReactNode } from 'react';
import { isSupersededConversation } from '@core/features/conversations/api/browser/handoff-visibility';
import { quickCreateTask } from '@core/features/tasks/api/browser/quick-create-task';
import { useTaskViewContext } from '@core/features/tasks/contributions/browser/task-view-context';
import {
  useConversations,
  useWorkspaceId,
} from '@core/features/workbench/api/browser/task-composition-context';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { OrkestraLogo } from '@core/primitives/app-identity/browser/orkestra-logo';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { useArrowKeyNavigation } from '@core/primitives/react-hooks/browser/use-arrow-key-navigation';
import { cn } from '@core/primitives/styling/browser/cn';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';

export const PaneEmptyState = observer(function PaneEmptyState() {
  const { projectId, taskId } = useTaskViewContext();
  const workspaceId = useWorkspaceId();
  const conversations = useConversations();
  const { pane } = usePaneContext();
  const { navigate } = useNavigate();
  const [creating, setCreating] = useState(false);
  const openCommandPalette = useOpenModal('commandPaletteModal');

  const existingConversations = Array.from(conversations.conversations.values()).filter(
    (conversation) => !isSupersededConversation(conversation.data.id)
  );
  const existingConversation =
    existingConversations.find((conversation) => conversation.isInitialConversation) ??
    existingConversations[existingConversations.length - 1];

  const actions = [
    () => {
      if (existingConversation) {
        pane.open(
          existingConversation.data.type === 'acp' ? 'acp-chat' : 'conversation',
          { conversationId: existingConversation.data.id },
          { preview: false }
        );
        return;
      }
      if (creating) return;
      setCreating(true);
      void quickCreateTask({ projectId, navigate }).finally(() => setCreating(false));
    },
    () => {
      void openCommandPalette({ projectId, taskId, workspaceId });
    },
    () => {
      pane.open('browser', {});
    },
  ];

  const { selectedIndex, setSelectedIndex } = useArrowKeyNavigation(actions.length, (index) =>
    actions[index]()
  );

  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3">
      <OrkestraLogo height={32} className="text-background-2" />
      <div className="mx-auto mt-10 flex w-full max-w-xs flex-col gap-0.5">
        <PaneEmptyStateAction
          isSelected={selectedIndex === 0}
          onMouseEnter={() => setSelectedIndex(0)}
          onClick={actions[0]}
          icon={
            creating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <MessageSquare className="size-3.5" />
            )
          }
          label={existingConversation ? 'Sohbeti aç' : 'Yeni sohbet'}
          busy={creating}
          commandId={existingConversation ? undefined : 'task.newConversation'}
        />
        <PaneEmptyStateAction
          isSelected={selectedIndex === 1}
          onMouseEnter={() => setSelectedIndex(1)}
          onClick={actions[1]}
          icon={<FileSearch className="size-3.5" />}
          label="Open file"
          commandId="app.commandPalette"
        />
        <PaneEmptyStateAction
          isSelected={selectedIndex === 2}
          onMouseEnter={() => setSelectedIndex(2)}
          onClick={actions[2]}
          icon={<Globe className="size-3.5" />}
          label="Tarayıcı aç"
          commandId="task.openBrowser"
        />
      </div>
    </div>
  );
});

function PaneEmptyStateAction({
  icon,
  label,
  commandId,
  isSelected,
  busy,
  onClick,
  onMouseEnter,
}: {
  icon: ReactNode;
  label: string;
  commandId?: string | undefined;
  isSelected?: boolean;
  busy?: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  return (
    <button
      type="button"
      data-slot="button"
      disabled={busy}
      aria-busy={busy}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        'flex items-center justify-between  gap-2 text-foreground-muted hover:text-foreground transition-colors hover:bg-background-1 py-2 px-3 rounded-md',
        isSelected && 'bg-background-1 text-foreground'
      )}
    >
      <div className="flex items-center gap-2 text-sm">
        {icon}
        {label}
      </div>
      {commandId ? <BoundShortcut command={commandId} variant="keycaps" /> : null}
    </button>
  );
}
