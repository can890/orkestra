import { AgentStatus } from '@orkestra/ui/react/components';
import { Button, Tooltip } from '@orkestra/ui/react/primitives';
import { ExternalLink, Maximize2, Minimize2, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  boardDragStore,
  isPointOverMainDropZone,
  resolveMainDropTarget,
} from '@core/features/board/api/browser/board-drag-store';
import { getBoardStore } from '@core/features/board/contributions/app-stores';
import { taskAgentStatus } from '@core/features/conversations/api/browser/conversation-selectors';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { EmbeddedTaskView } from '@core/features/tasks/contributions/browser/embedded-task-view';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { cn } from '@core/primitives/styling/browser/cn';
import { boardProjectHostLabel, boardProjectName } from './board-project-info';

const TILE_DRAG_THRESHOLD_PX = 6;

export interface BoardTileProps {
  readonly projectId: string;
  readonly taskId: string;
  readonly tileIndex?: number;
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
  tileIndex,
  isFocused,
  isMaximized,
  projectsLoaded,
  onFocus,
  onToggleMaximize,
  onRemove,
}: BoardTileProps) {
  const { navigate } = useNavigate();
  const focus = () => onFocus(taskId);
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const [dragChipPos, setDragChipPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => () => cleanupDragRef.current?.(), []);

  const task = getTaskStore(projectId, taskId);
  const dragLabel = task?.data.name || boardProjectName(projectId) || 'Görev';

  const startHeaderDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || isMaximized) return;
    if ((e.target as HTMLElement | null)?.closest('button')) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onEnd, true);
      window.removeEventListener('pointercancel', onCancel, true);
      cleanupDragRef.current = null;
      setDragChipPos(null);
      boardDragStore.reset();
    };

    const onMove = (moveEvent: PointerEvent) => {
      const point = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (!dragging) {
        if (Math.hypot(point.x - startX, point.y - startY) < TILE_DRAG_THRESHOLD_PX) return;
        dragging = true;
        boardDragStore.start(true, isPointOverMainDropZone(point), dragLabel, taskId);
      }
      boardDragStore.updatePoint(point);
      setDragChipPos(point);
    };

    const onEnd = (endEvent: PointerEvent) => {
      const point = { x: endEvent.clientX, y: endEvent.clientY };
      const hit = dragging ? resolveMainDropTarget(point, taskId) : null;
      cleanup();
      if (hit) {
        const board = getBoardStore();
        board.insertAt(
          { projectId, taskId },
          { side: hit.side, ...(hit.targetTaskId ? { targetTaskId: hit.targetTaskId } : {}) }
        );
        board.requestFocus(taskId);
      }
    };

    const onCancel = () => {
      cleanup();
    };

    cleanupDragRef.current?.();
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onEnd, true);
    window.addEventListener('pointercancel', onCancel, true);
    cleanupDragRef.current = cleanup;
  };

  return (
    <div
      data-testid="board-tile"
      data-task-id={taskId}
      data-focused={isFocused ? 'true' : 'false'}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/[0.09] bg-background"
      onPointerDownCapture={focus}
      onFocusCapture={focus}
    >
      <header
        className={cn(
          'flex h-8 shrink-0 items-center gap-1.5 border-b border-white/[0.07] pr-1 pl-2.5 text-xs transition-colors select-none',
          isFocused ? 'bg-white/[0.035]' : 'bg-white/[0.015]',
          !isMaximized && 'cursor-grab active:cursor-grabbing'
        )}
        onPointerDown={startHeaderDrag}
        onDoubleClick={() => onToggleMaximize(taskId)}
      >
        {tileIndex !== undefined ? (
          <span
            className="flex size-4 shrink-0 items-center justify-center rounded bg-white/[0.05] font-mono text-[10px] text-foreground-passive"
            title={`Hızlı odaklan (⌥${tileIndex + 1})`}
          >
            {tileIndex + 1}
          </span>
        ) : null}
        <BoardTileTitle projectId={projectId} taskId={taskId} projectsLoaded={projectsLoaded} />
        <div
          className="flex shrink-0 items-center gap-0.5"
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <TileAction
            label={isMaximized ? 'Izgaraya dön' : 'Büyüt (çift tık)'}
            onClick={() => onToggleMaximize(taskId)}
          >
            {isMaximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </TileAction>
          <TileAction
            label="Tam ekranda aç"
            onClick={() => navigate(taskViewDef({ projectId, taskId }))}
          >
            <ExternalLink className="size-3.5" />
          </TileAction>
          <TileAction label="Panodan çıkar" onClick={() => onRemove(taskId)}>
            <X className="size-3.5" />
          </TileAction>
        </div>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <EmbeddedTaskView projectId={projectId} taskId={taskId} isActive={isFocused} />
      </div>
      {dragChipPos && (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-border bg-background-tertiary px-2.5 py-1 text-xs font-medium text-foreground shadow-md"
          style={{ left: dragChipPos.x + 12, top: dragChipPos.y + 12 }}
        >
          {dragLabel}
        </div>
      )}
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
