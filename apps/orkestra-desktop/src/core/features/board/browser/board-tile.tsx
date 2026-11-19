import { AgentStatus } from '@orkestra/ui/react/components';
import { Button, Tooltip } from '@orkestra/ui/react/primitives';
import { ExternalLink, Maximize2, Minimize2, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { taskAgentStatus } from '@core/features/conversations/api/browser/conversation-selectors';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { EmbeddedTaskView } from '@core/features/tasks/contributions/browser/embedded-task-view';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { cn } from '@core/primitives/styling/browser/cn';
import { boardProjectHostLabel, boardProjectName } from './board-project-info';

export interface BoardTileProps {
  readonly projectId: string;
  readonly taskId: string;
  readonly isFocused: boolean;
  readonly isMaximized: boolean;
  /** False until the project list has loaded; suppresses fallback labels during startup. */
  readonly projectsLoaded: boolean;
  readonly onFocus: (taskId: string) => void;
  readonly onToggleMaximize: (taskId: string) => void;
  readonly onRemove: (taskId: string) => void;
}

export const BoardTile = observer(function BoardTile({
  projectId,
  taskId,
  isFocused,
  isMaximized,
  projectsLoaded,
  onFocus,
  onToggleMaximize,
  onRemove,
}: BoardTileProps) {
  const { navigate } = useNavigate();
  const focus = () => onFocus(taskId);

  return (
    <div
      data-testid="board-tile"
      data-task-id={taskId}
      data-focused={isFocused ? 'true' : 'false'}
      className={cn(
        'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border bg-background transition-colors',
        isFocused ? 'border-accent/60' : 'border-border'
      )}
      onPointerDownCapture={focus}
      onFocusCapture={focus}
    >
      <header
        className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-background-secondary pr-1 pl-2.5 text-xs"
        onDoubleClick={() => onToggleMaximize(taskId)}
      >
        <BoardTileTitle projectId={projectId} taskId={taskId} projectsLoaded={projectsLoaded} />
        <div
          className="flex shrink-0 items-center gap-0.5"
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <TileAction
            label={isMaximized ? 'Shrink to grid' : 'Maximize'}
            onClick={() => onToggleMaximize(taskId)}
          >
            {isMaximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </TileAction>
          <TileAction
            label="Open task"
            onClick={() => navigate(taskViewDef({ projectId, taskId }))}
          >
            <ExternalLink className="size-3.5" />
          </TileAction>
          <TileAction label="Remove from board" onClick={() => onRemove(taskId)}>
            <X className="size-3.5" />
          </TileAction>
        </div>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <EmbeddedTaskView projectId={projectId} taskId={taskId} isActive={isFocused} />
      </div>
    </div>
  );
});

/**
 * Names resolve defensively: a deleted task or project falls back to a neutral label, and
 * nothing is invented while projects are still loading at startup.
 */
const BoardTileTitle = observer(function BoardTileTitle({
  projectId,
  taskId,
  projectsLoaded,
}: {
  projectId: string;
  taskId: string;
  projectsLoaded: boolean;
}) {
  const task = getTaskStore(projectId, taskId);
  const projectName = boardProjectName(projectId);
  const hostLabel = boardProjectHostLabel(projectId);
  const status = task ? taskAgentStatus(task) : null;

  const projectLabel = projectName ?? (projectsLoaded ? 'Project' : '');
  const taskLabel = task?.data.name || (projectsLoaded ? 'Task' : '');

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="max-w-[40%] min-w-0 shrink truncate text-foreground-muted">
        {projectLabel}
      </span>
      <span className="shrink-0 text-foreground-passive" aria-hidden="true">
        /
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{taskLabel}</span>
      {hostLabel ? (
        <span
          className="max-w-24 shrink-0 truncate rounded-sm bg-background-tertiary px-1 py-px text-[10px] leading-4 text-foreground-muted"
          title={hostLabel}
        >
          {hostLabel}
        </span>
      ) : null}
      {status !== null ? (
        <span className="flex shrink-0 items-center">
          <AgentStatus status={status} tooltip />
        </span>
      ) : null}
    </div>
  );
});

function TileAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={<Button variant="ghost" size="xs" icon aria-label={label} onClick={onClick} />}
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip.Root>
  );
}
