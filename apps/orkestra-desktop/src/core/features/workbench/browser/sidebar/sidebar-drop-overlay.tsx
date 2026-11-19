import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { MAIN_DROP_ZONE_ATTRIBUTE, sidebarDragStore } from './sidebar-drag-store';

const SidebarDropOverlay = observer(function SidebarDropOverlay() {
  if (!sidebarDragStore.showOverlay) return null;
  return (
    <div
      data-testid="sidebar-drop-overlay"
      className="border-primary/50 pointer-events-none absolute inset-0 z-50 flex items-start justify-center border-2 border-dashed bg-background/50 pt-24"
    >
      <span className="rounded-md bg-background-tertiary px-3 py-1.5 text-sm text-foreground shadow-md">
        Drop to open side by side
      </span>
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
