import { MicroLabel } from '@orkestra/ui/react/primitives';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { when } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { getConversationsForTask } from '@core/features/conversations/api/browser/conversation-selectors';
import { getProjectStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { isFreeChatProjectId } from '@core/primitives/projects/api';
import { SidebarItemMiniButton, SidebarMenu, SidebarMenuButton } from './sidebar-primitives';

const dateFormat = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

type SectionEntry = {
  projectId: string;
  taskId: string;
} & ({ until: number } | { conversationId: string; reason: 'awaiting-input' | 'error' });

const AttentionRow = observer(function AttentionRow({ entry }: { entry: SectionEntry }) {
  const { projectId, taskId } = entry;
  const { navigate } = useNavigate();
  const stopOpening = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stopOpening.current?.(), []);
  const task = getTaskStore(projectId, taskId);
  if (!task) return null;

  function open() {
    navigate(taskViewDef({ projectId, taskId }));
    if (!('conversationId' in entry)) return;
    const { conversationId } = entry;
    stopOpening.current?.();
    stopOpening.current = when(
      () =>
        Boolean(
          getTaskComposition(projectId, taskId) &&
          getConversationsForTask(taskId)?.conversations.has(conversationId)
        ),
      () => {
        const conversation = getConversationsForTask(taskId)?.conversations.get(conversationId);
        const composition = getTaskComposition(projectId, taskId);
        if (!conversation || !composition) return;
        composition.paneLayout.open(
          conversation.data.type === 'acp' ? 'acp-chat' : 'conversation',
          { conversationId },
          { preview: false }
        );
      },
      { timeout: 10_000, onError: () => {} }
    );
  }

  const name = task.data.name || 'Sohbet';
  const projectName = isFreeChatProjectId(projectId)
    ? 'Sohbet'
    : (getProjectStore(projectId)?.name ?? 'Proje');
  const details =
    'until' in entry
      ? dateFormat.format(entry.until)
      : entry.reason === 'error'
        ? 'Hata'
        : 'Yanıt bekliyor';

  return (
    <div className="flex min-w-0 items-center gap-1">
      <SidebarMenuButton
        type="button"
        onClick={open}
        title={`${projectName} · ${name} · ${details}`}
        className="min-w-0 flex-1 justify-between gap-2 px-2"
      >
        <span className="truncate">{name}</span>
        <span className="shrink-0 text-[10px] text-foreground-tertiary-muted">{details}</span>
      </SidebarMenuButton>
      {'until' in entry && (
        <SidebarItemMiniButton
          type="button"
          aria-label={`${name} için ertelemeyi kaldır`}
          title="Ertelemeyi kaldır"
          onClick={() => getSidebarStore().restoreSnoozedTask(taskId)}
        >
          <RotateCcw className="size-3.5" />
        </SidebarItemMiniButton>
      )}
    </div>
  );
});

export const SidebarAttentionSection = observer(function SidebarAttentionSection({
  section,
}: {
  section: 'snoozed' | 'waiting';
}) {
  const store = getSidebarStore();
  const entries = section === 'snoozed' ? store.snoozedEntries : store.waitingEntries;
  const open = store.isSectionOpen(section) || store.searchQuery.trim().length > 0;
  if (entries.length === 0) return null;

  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="mt-3 border-t border-border/50 pt-2">
      <button
        type="button"
        onClick={() => store.toggleSectionOpen(section)}
        aria-expanded={open}
        className="flex h-8 w-full items-center gap-1.5 px-2 text-left text-foreground-tertiary-passive hover:text-foreground"
      >
        <MicroLabel className="truncate font-medium">
          {section === 'snoozed' ? 'Ertelenenler' : 'Seni bekleyenler'}
        </MicroLabel>
        <span className="text-[11px] tabular-nums">({entries.length})</span>
        <Chevron className="size-3.5 shrink-0 opacity-70" />
      </button>
      {open && (
        <SidebarMenu>
          {entries.map((entry) => (
            <AttentionRow
              key={'conversationId' in entry ? entry.conversationId : entry.taskId}
              entry={entry}
            />
          ))}
        </SidebarMenu>
      )}
    </div>
  );
});
