import { makeAutoObservable } from 'mobx';

/** DOM marker of the main content area that accepts sidebar drags. */
export const MAIN_DROP_ZONE_ATTRIBUTE = 'data-sidebar-main-drop-zone';

/**
 * Tiny observable bridge between the sidebar's drag-and-drop and the main area. The sidebar owns
 * drag tracking; the main area only needs to know whether a droppable sidebar item is being
 * dragged over it so it can show the split drop overlay.
 */
class SidebarDragStore {
  /** A sidebar task/project drag that can be shown side by side is in progress. */
  droppable = false;
  /** The pointer is currently over the main content area. */
  overMain = false;
  /** Display title of the dragged conversation/task for the preview overlay. */
  dragLabel: string | null = null;
  /** Current viewport pointer position during direct sidebar drags. */
  pointer: { x: number; y: number } | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  start(droppable: boolean, overMain: boolean, dragLabel: string | null = null): void {
    this.droppable = droppable;
    this.overMain = overMain;
    this.dragLabel = dragLabel;
  }

  setOverMain(overMain: boolean): void {
    if (this.overMain !== overMain) this.overMain = overMain;
  }

  setPointer(pointer: { x: number; y: number } | null): void {
    this.pointer = pointer;
  }

  reset(): void {
    this.droppable = false;
    this.overMain = false;
    this.dragLabel = null;
    this.pointer = null;
  }

  get showOverlay(): boolean {
    return this.droppable && this.overMain;
  }
}

export const sidebarDragStore = new SidebarDragStore();

/** Hit-tests a viewport point against the main content area. */
export function isPointOverMainDropZone(point: { x: number; y: number } | null): boolean {
  if (!point || typeof document === 'undefined') return false;
  const zone = document.querySelector(`[${MAIN_DROP_ZONE_ATTRIBUTE}]`);
  if (!zone) return false;
  const rect = zone.getBoundingClientRect();
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}
