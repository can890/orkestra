import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import { gridShape, neighbourAfterRemoval } from '@core/features/board/api/board-layout';
import { getBoardStore } from '@core/features/board/contributions/app-stores';
import { useProjectsLoaded } from './board-project-info';
import { BoardAddTaskButton } from './board-task-picker';
import { BoardTile } from './board-tile';

export const BoardMain = observer(function BoardMain() {
  const board = getBoardStore();
  const tiles = board.tiles;
  const projectsLoaded = useProjectsLoaded();

  const [focusedTaskId, setFocusedTaskId] = useState<string | undefined>(undefined);
  const [maximizedTaskId, setMaximizedTaskId] = useState<string | undefined>(undefined);

  const taskIds = tiles.map((tile) => tile.taskId);
  const hasTask = (taskId: string | undefined) => taskId !== undefined && taskIds.includes(taskId);

  // Derived so a removed tile never leaves a dangling focus for a render; the effect below drops
  // the stale ids so a task re-added later does not come back focused or maximized.
  const effectiveMaximizedId = hasTask(maximizedTaskId) ? maximizedTaskId : undefined;
  const effectiveFocusedId = effectiveMaximizedId
    ? effectiveMaximizedId
    : hasTask(focusedTaskId)
      ? focusedTaskId
      : tiles[0]?.taskId;

  const idsKey = taskIds.join('\u0000');
  useEffect(() => {
    const present = idsKey === '' ? [] : idsKey.split('\u0000');
    setFocusedTaskId((current) => (current && present.includes(current) ? current : undefined));
    setMaximizedTaskId((current) => (current && present.includes(current) ? current : undefined));
  }, [idsKey]);

  const handleFocus = useCallback((taskId: string) => setFocusedTaskId(taskId), []);
  const handleToggleMaximize = useCallback((taskId: string) => {
    setMaximizedTaskId((current) => (current === taskId ? undefined : taskId));
    setFocusedTaskId(taskId);
  }, []);
  const handleRemove = (taskId: string) => {
    if (taskId === effectiveFocusedId) setFocusedTaskId(neighbourAfterRemoval(tiles, taskId));
    board.remove(taskId);
  };

  if (tiles.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-background p-6">
        <p className="text-sm text-foreground-muted">See several tasks side by side</p>
        <BoardAddTaskButton />
      </div>
    );
  }

  const visibleTiles = effectiveMaximizedId
    ? tiles.filter((tile) => tile.taskId === effectiveMaximizedId)
    : tiles;
  const { columns, rows } = effectiveMaximizedId
    ? { columns: 1, rows: 1 }
    : gridShape(visibleTiles.length);

  return (
    <div
      data-testid="board-grid"
      data-columns={columns}
      data-rows={rows}
      className="grid h-full min-h-0 min-w-0 gap-1 overflow-hidden bg-background-secondary p-1"
      style={{
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
    >
      {visibleTiles.map((tile) => (
        <BoardTile
          key={tile.taskId}
          projectId={tile.projectId}
          taskId={tile.taskId}
          isFocused={tile.taskId === effectiveFocusedId}
          isMaximized={tile.taskId === effectiveMaximizedId}
          projectsLoaded={projectsLoaded}
          onFocus={handleFocus}
          onToggleMaximize={handleToggleMaximize}
          onRemove={handleRemove}
        />
      ))}
    </div>
  );
});
