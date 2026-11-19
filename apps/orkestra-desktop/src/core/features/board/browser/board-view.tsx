import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { MAX_BOARD_TILES } from '@core/features/board/api/board-layout';
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
      <span className="rounded-sm px-1 py-0.5 text-sm text-foreground">Board</span>
      <span className="text-xs text-foreground-muted tabular-nums">
        {getBoardStore().tiles.length} / {MAX_BOARD_TILES}
      </span>
    </nav>
  );
});

export function BoardTitlebar() {
  return <Titlebar leftSlot={<BoardBreadcrumb />} rightSlot={<BoardAddTaskButton />} />;
}

export const boardViewRuntime = defineViewRuntime(boardViewDef, {
  slots: {
    wrap: BoardViewWrapper,
    titlebar: BoardTitlebar,
    main: BoardMain,
  },
});
