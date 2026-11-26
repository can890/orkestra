import { Resizable } from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  buildDefaultBoardLayout,
  gridShape,
  neighbourAfterRemoval,
  type BoardLayoutNode,
} from '@core/features/board/api/board-layout';
import { getBoardStore } from '@core/features/board/contributions/app-stores';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { useProjectsLoaded } from './board-project-info';
import { BoardAddTaskButton } from './board-task-picker';
import { BoardTile } from './board-tile';

function present(idsKey: string, taskId: string): boolean {
  return idsKey !== '' && idsKey.split('\u0000').includes(taskId);
}

function layoutNodeKey(node: BoardLayoutNode): string {
  return node.kind === 'tile'
    ? node.taskId
    : `split:${node.axis}:[${node.children.map(layoutNodeKey).join(',')}]`;
}

export const BoardMain = observer(function BoardMain() {
  const board = getBoardStore();
  const tiles = board.tiles;
  const customLayout = board.layout;
  const projectsLoaded = useProjectsLoaded();
  const { navigate } = useNavigate();

  const [focusedTaskId, setFocusedTaskId] = useState<string | undefined>(undefined);
  const [maximizedTaskId, setMaximizedTaskId] = useState<string | undefined>(undefined);
  const prevTileCountRef = useRef(tiles.length);

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
    const currentPresent = idsKey === '' ? [] : idsKey.split('\u0000');
    setFocusedTaskId((current) =>
      current && currentPresent.includes(current) ? current : undefined
    );
    setMaximizedTaskId((current) =>
      current && currentPresent.includes(current) ? current : undefined
    );
  }, [idsKey]);

  // Pano 2 veya daha fazla sohbetten teke düştüğü anda (ör. yan menüden silme/arşivleme ile)
  // otomatik olarak kalan tek konuşmadan devam edip pano modundan çık.
  useEffect(() => {
    const prevCount = prevTileCountRef.current;
    prevTileCountRef.current = tiles.length;
    if (prevCount >= 2 && tiles.length === 1 && tiles[0]) {
      navigate(taskViewDef({ projectId: tiles[0].projectId, taskId: tiles[0].taskId }));
    }
  }, [tiles.length, tiles[0]?.projectId, tiles[0]?.taskId, navigate]);

  // A sidebar drop asks for the new tile to take focus. The request waits until the tile is on the
  // board (the layout write can land after the request) and un-maximizes so the tile is visible.
  const pendingFocusId = board.pendingFocusTaskId;
  useEffect(() => {
    if (!pendingFocusId || !present(idsKey, pendingFocusId)) return;
    setMaximizedTaskId(undefined);
    setFocusedTaskId(pendingFocusId);
    board.consumeFocus(pendingFocusId);
  }, [board, pendingFocusId, idsKey]);

  // Kısayollar: Alt+1..6 ile ilgili sohbete odaklan, Cmd+Shift+M ile aktif sohbeti büyüt/küçült.
  useEffect(() => {
    if (tiles.length < 2) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        const digit = Number(event.key);
        if (digit >= 1 && digit <= tiles.length) {
          const target = tiles[digit - 1];
          if (target) {
            event.preventDefault();
            setMaximizedTaskId(undefined);
            setFocusedTaskId(target.taskId);
          }
        }
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'm' &&
        effectiveFocusedId
      ) {
        event.preventDefault();
        setMaximizedTaskId((current) => (current === effectiveFocusedId ? undefined : effectiveFocusedId));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tiles, effectiveFocusedId]);

  const handleFocus = useCallback((taskId: string) => setFocusedTaskId(taskId), []);
  const handleToggleMaximize = useCallback((taskId: string) => {
    setMaximizedTaskId((current) => (current === taskId ? undefined : taskId));
    setFocusedTaskId(taskId);
  }, []);
  const handleRemove = (taskId: string) => {
    const remaining = tiles.filter((tile) => tile.taskId !== taskId);
    if (taskId === effectiveFocusedId) setFocusedTaskId(neighbourAfterRemoval(tiles, taskId));
    board.remove(taskId);
    // Pano teke düştüğü an kalan konuşmadan devam edip pano modundan çık.
    if (remaining.length === 1 && remaining[0]) {
      navigate(taskViewDef({ projectId: remaining[0].projectId, taskId: remaining[0].taskId }));
    }
  };

  if (tiles.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-background p-6">
        <p className="text-sm text-foreground-muted">Birden fazla sohbeti yan yana takip edin</p>
        <BoardAddTaskButton />
      </div>
    );
  }

  const tileIndexById = new Map(tiles.map((tile, idx) => [tile.taskId, idx] as const));

  // 2 sohbet açıkken özel düzen seçilmemiş olsa bile sürükleyerek boyutlandırılabilir bölme kullan.
  const effectiveSplitLayout: BoardLayoutNode | null =
    !effectiveMaximizedId && customLayout && customLayout.kind === 'split'
      ? customLayout
      : !effectiveMaximizedId && tiles.length === 2
        ? buildDefaultBoardLayout(tiles, 'horizontal')
        : null;

  if (effectiveSplitLayout && effectiveSplitLayout.kind === 'split' && !effectiveMaximizedId) {
    const renderNode = (node: BoardLayoutNode) => {
      if (node.kind === 'tile') {
        return (
          <BoardTile
            projectId={node.projectId}
            taskId={node.taskId}
            tileIndex={tileIndexById.get(node.taskId)}
            isFocused={node.taskId === effectiveFocusedId}
            isMaximized={false}
            projectsLoaded={projectsLoaded}
            onFocus={handleFocus}
            onToggleMaximize={handleToggleMaximize}
            onRemove={handleRemove}
          />
        );
      }

      const groupKey = `${node.id}:${node.children.map(layoutNodeKey).join(',')}`;
      return (
        <Resizable.Group
          key={groupKey}
          orientation={node.axis}
          className="h-full min-h-0 w-full min-w-0"
        >
          {node.children.map((child, idx) => {
            const panelId =
              child.kind === 'tile' ? `tile:${child.taskId}` : `split:${idx}:${child.id}`;
            return (
              <Fragment key={panelId}>
                <Resizable.Panel
                  id={panelId}
                  minSize="15%"
                  className="flex min-h-0 min-w-0 flex-col overflow-hidden"
                >
                  {renderNode(child)}
                </Resizable.Panel>
                {idx < node.children.length - 1 && (
                  <Resizable.Handle
                    variant="ghost"
                    className={node.axis === 'horizontal' ? 'w-1.5' : 'h-1.5'}
                  />
                )}
              </Fragment>
            );
          })}
        </Resizable.Group>
      );
    };

    return (
      <div
        data-testid="board-grid"
        data-layout="split"
        className="h-full min-h-0 min-w-0 overflow-hidden bg-background p-1.5"
      >
        {renderNode(effectiveSplitLayout)}
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
      className="grid h-full min-h-0 min-w-0 gap-1.5 overflow-hidden bg-background p-1.5"
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
          tileIndex={tiles.length > 1 ? tileIndexById.get(tile.taskId) : undefined}
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
