import { Button, Tooltip } from '@orkestra/ui/react/primitives';
import { ArrowLeftRight, Columns2, LayoutGrid, Rows2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { MAX_BOARD_TILES, rootSplitAxis } from '@core/features/board/api/board-layout';
import { getBoardStore } from '@core/features/board/contributions/app-stores';
import { boardViewDef } from '@core/features/board/contributions/views';
import { Titlebar } from '@core/features/workbench/contributions/browser/Titlebar';
import { defineViewRuntime } from '@core/primitives/views/react';
import { BoardMain } from './board-main';
import { BoardAddTaskButton } from './board-task-picker';

export function BoardViewWrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

const BoardBreadcrumb = observer(function BoardBreadcrumb() {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-2 px-2">
      <span className="rounded-sm px-1 py-0.5 text-sm font-medium text-foreground">Pano</span>
      <span className="text-xs text-foreground-muted tabular-nums">
        {getBoardStore().tiles.length} / {MAX_BOARD_TILES}
      </span>
    </nav>
  );
});

const BoardArrangementControls = observer(function BoardArrangementControls() {
  const board = getBoardStore();
  if (board.tiles.length < 2) return null;

  const axis = rootSplitAxis(board.layout);
  const mode: 'horizontal' | 'vertical' | 'grid' =
    axis ?? (board.tiles.length === 2 ? 'horizontal' : 'grid');

  return (
    <div className="flex items-center gap-1">
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              type="button"
              size="xs"
              icon
              variant="ghost"
              aria-label="Panelleri yer değiştir"
              onClick={() => board.swapTiles()}
            />
          }
        >
          <ArrowLeftRight className="size-3.5" />
        </Tooltip.Trigger>
        <Tooltip.Content>Yer değiştir</Tooltip.Content>
      </Tooltip.Root>

      <div className="flex items-center gap-0.5 rounded-md border border-border bg-background-secondary p-0.5">
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <Button
                type="button"
                size="xs"
                icon
                variant={mode === 'horizontal' ? 'secondary' : 'ghost'}
                aria-label="Yan yana düzen"
                onClick={() => board.setArrangement('horizontal')}
              />
            }
          >
            <Columns2 className="size-3.5" />
          </Tooltip.Trigger>
          <Tooltip.Content>Yan yana</Tooltip.Content>
        </Tooltip.Root>
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <Button
                type="button"
                size="xs"
                icon
                variant={mode === 'vertical' ? 'secondary' : 'ghost'}
                aria-label="Alt alta düzen"
                onClick={() => board.setArrangement('vertical')}
              />
            }
          >
            <Rows2 className="size-3.5" />
          </Tooltip.Trigger>
          <Tooltip.Content>Alt alta</Tooltip.Content>
        </Tooltip.Root>
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <Button
                type="button"
                size="xs"
                icon
                variant={mode === 'grid' ? 'secondary' : 'ghost'}
                aria-label="Izgara düzeni"
                onClick={() => board.setArrangement('grid')}
              />
            }
          >
            <LayoutGrid className="size-3.5" />
          </Tooltip.Trigger>
          <Tooltip.Content>Otomatik ızgara</Tooltip.Content>
        </Tooltip.Root>
      </div>
    </div>
  );
});

export function BoardTitlebar() {
  return (
    <Titlebar
      leftSlot={<BoardBreadcrumb />}
      rightSlot={
        <div className="flex items-center gap-2">
          <BoardArrangementControls />
          <BoardAddTaskButton />
        </div>
      }
    />
  );
}

export const boardViewRuntime = defineViewRuntime(boardViewDef, {
  slots: {
    wrap: BoardViewWrapper,
    titlebar: BoardTitlebar,
    main: BoardMain,
  },
});
