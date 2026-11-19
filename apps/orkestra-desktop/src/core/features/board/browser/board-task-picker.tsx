import { Button, Popover, SearchInput } from '@orkestra/ui/react/primitives';
import { Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { MAX_BOARD_TILES } from '@core/features/board/api/board-layout';
import {
  isBoardEligibleTask,
  taskRecency,
} from '@core/features/board/api/browser/board-eligibility';
import { getBoardStore } from '@core/features/board/contributions/app-stores';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import { boardProjectHostLabel, boardProjectName } from './board-project-info';

interface PickerGroup {
  readonly projectId: string;
  readonly projectName: string;
  readonly hostLabel: string | undefined;
  readonly tasks: readonly { taskId: string; name: string }[];
}

/**
 * Source: every project from the sidebar ordering (`SidebarStore.orderedProjects`) with its tasks
 * from `getTaskManagerStore(projectId).tasks`. `SidebarStore.visibleTaskEntries` only lists tasks
 * of expanded projects, so it cannot serve a cross-project picker. Observer-only.
 */
function collectGroups(query: string): PickerGroup[] {
  const board = getBoardStore();
  const needle = query.trim().toLowerCase();
  const groups: PickerGroup[] = [];

  for (const project of getSidebarStore().orderedProjects) {
    const projectName = boardProjectName(project.id) ?? '';
    const projectMatches = needle !== '' && projectName.toLowerCase().includes(needle);
    const manager = getTaskManagerStore(project.id);
    if (!manager) continue;

    const tasks = [...manager.tasks.values()]
      .filter((task) => {
        if (!isBoardEligibleTask(task)) return false;
        if (board.hasTask(task.data.id)) return false;
        return needle === '' || projectMatches || task.data.name.toLowerCase().includes(needle);
      })
      .sort((a, b) => taskRecency(b) - taskRecency(a))
      .map((task) => ({ taskId: task.data.id, name: task.data.name }));

    if (tasks.length === 0) continue;
    groups.push({
      projectId: project.id,
      projectName,
      hostLabel: boardProjectHostLabel(project.id),
      tasks,
    });
  }
  return groups;
}

/** "Add task" button that opens a searchable, project-grouped task picker. */
export const BoardAddTaskButton = observer(function BoardAddTaskButton({
  variant = 'secondary',
}: {
  variant?: 'secondary' | 'ghost';
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Popover.Trigger render={<Button variant={variant} size="xs" />}>
        <Plus className="size-3.5" />
        Add task
      </Popover.Trigger>
      <Popover.Content align="end" className="w-80 p-0">
        <BoardTaskPickerPanel
          query={query}
          onQueryChange={setQuery}
          onPicked={() => setOpen(false)}
        />
      </Popover.Content>
    </Popover.Root>
  );
});

const BoardTaskPickerPanel = observer(function BoardTaskPickerPanel({
  query,
  onQueryChange,
  onPicked,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  onPicked: () => void;
}) {
  const board = getBoardStore();
  if (board.tiles.length >= MAX_BOARD_TILES) {
    return (
      <p className="px-3 py-2.5 text-xs text-foreground-muted" role="status">
        Board is full (6 tasks)
      </p>
    );
  }

  const groups = collectGroups(query);

  return (
    <div className="flex flex-col">
      <div className="border-b border-border p-2">
        <SearchInput
          size="sm"
          autoFocus
          value={query}
          placeholder="Search tasks…"
          aria-label="Search tasks…"
          onChange={(event) => onQueryChange(event.target.value)}
          onClear={() => onQueryChange('')}
        />
      </div>
      <div className="max-h-80 overflow-y-auto py-1">
        {groups.length === 0 ? (
          <p className="px-3 py-2.5 text-xs text-foreground-muted">
            {query.trim() === '' ? 'No tasks to add' : 'No matching tasks'}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.projectId} role="group" aria-label={group.projectName || 'Project'}>
              <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[11px] text-foreground-passive">
                <span className="min-w-0 truncate">{group.projectName}</span>
                {group.hostLabel ? (
                  <span className="max-w-24 shrink-0 truncate rounded-sm bg-background-tertiary px-1 text-[10px] text-foreground-muted">
                    {group.hostLabel}
                  </span>
                ) : null}
              </div>
              {group.tasks.map((task) => (
                <button
                  key={task.taskId}
                  type="button"
                  className="block w-full truncate px-3 py-1.5 text-left text-sm text-foreground hover:bg-background-tertiary focus-visible:bg-background-tertiary focus-visible:outline-none"
                  onClick={() => {
                    board.add({ projectId: group.projectId, taskId: task.taskId });
                    onPicked();
                  }}
                >
                  {task.name}
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
});
