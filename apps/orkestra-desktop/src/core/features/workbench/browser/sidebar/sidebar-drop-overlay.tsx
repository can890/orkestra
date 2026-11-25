import { Columns2, Rows2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import type { BoardDropSide } from '@core/features/board/api/board-layout';
import { MAIN_DROP_ZONE_ATTRIBUTE, sidebarDragStore } from './sidebar-drag-store';

function dropCopy(side: BoardDropSide): { label: string; isVertical: boolean } {
  switch (side) {
    case 'top':
      return { label: 'Üste ekle (alt alta)', isVertical: true };
    case 'bottom':
      return { label: 'Alta ekle (alt alta)', isVertical: true };
    case 'left':
      return { label: 'Sola ekle (yan yana)', isVertical: false };
    case 'right':
    default:
      return { label: 'Sağa ekle (yan yana)', isVertical: false };
  }
}

const SidebarDropOverlay = observer(function SidebarDropOverlay() {
  if (!sidebarDragStore.showOverlay) return null;
  const hit = sidebarDragStore.hit;
  const side: BoardDropSide = hit?.side ?? 'right';
  const { label, isVertical } = dropCopy(side);

  return (
    <div
      data-testid="sidebar-drop-overlay"
      data-drop-side={side}
      className="pointer-events-none absolute inset-0 z-50 bg-background/25 backdrop-blur-[1px]"
    >
      {hit ? (
        <div
          className="border-primary/70 bg-primary/12 absolute flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-4 text-center shadow-sm transition-all duration-100 ease-out"
          style={{
            left: `${hit.previewRect.left}px`,
            top: `${hit.previewRect.top}px`,
            width: `${hit.previewRect.width}px`,
            height: `${hit.previewRect.height}px`,
          }}
        >
          <span className="flex size-9 items-center justify-center rounded-full border border-border bg-background/90 text-foreground shadow-sm">
            {isVertical ? <Rows2 className="size-4" /> : <Columns2 className="size-4" />}
          </span>
          <span className="text-sm font-medium text-foreground">{label}</span>
          {sidebarDragStore.dragLabel ? (
            <span className="max-w-xs truncate rounded bg-background/85 px-2 py-0.5 text-xs text-foreground-muted">
              {sidebarDragStore.dragLabel}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="grid h-full w-full grid-cols-2 gap-1.5 p-2">
          <div className="rounded-md border border-border/50 bg-background/25" />
          <div className="border-primary/65 bg-primary/10 flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-4 text-center shadow-sm">
            <span className="flex size-9 items-center justify-center rounded-full border border-border bg-background/90 text-foreground shadow-sm">
              <Columns2 className="size-4" />
            </span>
            <span className="text-sm font-medium text-foreground">{label}</span>
            {sidebarDragStore.dragLabel ? (
              <span className="max-w-xs truncate rounded bg-background/80 px-2 py-0.5 text-xs text-foreground-muted">
                {sidebarDragStore.dragLabel}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
});

/** Wraps the main content so a sidebar/board-tile drag gets a directional drop target and overlay. */
export function MainDropZone({ children }: { children: ReactNode }) {
  return (
    <div {...{ [MAIN_DROP_ZONE_ATTRIBUTE]: '' }} className="relative h-full w-full min-w-0">
      {children}
      <SidebarDropOverlay />
    </div>
  );
}
