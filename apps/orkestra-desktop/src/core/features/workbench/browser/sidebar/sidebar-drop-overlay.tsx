import { Columns2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { MAIN_DROP_ZONE_ATTRIBUTE, sidebarDragStore } from './sidebar-drag-store';

const SidebarDropOverlay = observer(function SidebarDropOverlay() {
  if (!sidebarDragStore.showOverlay) return null;
  return (
    <div
      data-testid="sidebar-drop-overlay"
      className="pointer-events-none absolute inset-0 z-50 grid grid-cols-2 gap-1.5 bg-background/35 p-2 backdrop-blur-[1px]"
    >
      <div className="rounded-md border border-border/50 bg-background/25" />
      <div className="border-primary/65 bg-primary/10 flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-4 text-center shadow-sm">
        <span className="bg-background/90 flex size-9 items-center justify-center rounded-full border border-border text-foreground shadow-sm">
          <Columns2 className="size-4" />
        </span>
        <span className="text-sm font-medium text-foreground">
          Yan yana açmak için buraya bırak
        </span>
        {sidebarDragStore.dragLabel ? (
          <span className="max-w-xs truncate rounded bg-background/80 px-2 py-0.5 text-xs text-foreground-muted">
            {sidebarDragStore.dragLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
});

/** Wraps the main content so a sidebar task/project drag gets a drop target and overlay. */
export function MainDropZone({ children }: { children: ReactNode }) {
  return (
    <div {...{ [MAIN_DROP_ZONE_ATTRIBUTE]: '' }} className="relative h-full w-full min-w-0">
      {children}
      <SidebarDropOverlay />
    </div>
  );
}
