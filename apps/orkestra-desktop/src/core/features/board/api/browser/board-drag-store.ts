import { makeAutoObservable } from 'mobx';
import type { BoardDropSide } from '@core/features/board/api/board-layout';

/** DOM marker of the main content area that accepts sidebar and board-tile drags. */
export const MAIN_DROP_ZONE_ATTRIBUTE = 'data-sidebar-main-drop-zone';

export interface MainDropHit {
  readonly side: BoardDropSide;
  readonly targetTaskId?: string;
  readonly previewRect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}

function nearestQuadSide(
  point: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number }
): BoardDropSide {
  const width = Math.max(rect.width, 1);
  const height = Math.max(rect.height, 1);
  const nx = Math.max(0, Math.min(1, (point.x - rect.left) / width));
  const ny = Math.max(0, Math.min(1, (point.y - rect.top) / height));

  const dLeft = nx;
  const dRight = 1 - nx;
  const dTop = ny;
  const dBottom = 1 - ny;

  let best: BoardDropSide = 'right';
  let min = dRight;
  if (dLeft < min) {
    min = dLeft;
    best = 'left';
  }
  if (dTop < min) {
    min = dTop;
    best = 'top';
  }
  if (dBottom < min) {
    best = 'bottom';
  }
  return best;
}

function halfPreviewRect(
  side: BoardDropSide,
  targetRect: { left: number; top: number; width: number; height: number },
  mainRect: { left: number; top: number }
): MainDropHit['previewRect'] {
  const pad = 6;
  const baseLeft = targetRect.left - mainRect.left;
  const baseTop = targetRect.top - mainRect.top;
  const w = targetRect.width;
  const h = targetRect.height;

  switch (side) {
    case 'left':
      return {
        left: baseLeft + pad,
        top: baseTop + pad,
        width: Math.max(24, w * 0.5 - pad * 1.5),
        height: Math.max(24, h - pad * 2),
      };
    case 'right':
      return {
        left: baseLeft + w * 0.5 + pad * 0.5,
        top: baseTop + pad,
        width: Math.max(24, w * 0.5 - pad * 1.5),
        height: Math.max(24, h - pad * 2),
      };
    case 'top':
      return {
        left: baseLeft + pad,
        top: baseTop + pad,
        width: Math.max(24, w - pad * 2),
        height: Math.max(24, h * 0.5 - pad * 1.5),
      };
    case 'bottom':
      return {
        left: baseLeft + pad,
        top: baseTop + h * 0.5 + pad * 0.5,
        width: Math.max(24, w - pad * 2),
        height: Math.max(24, h * 0.5 - pad * 1.5),
      };
  }
}

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

/**
 * Verilen fare konumunun ana alan içindeki hangi karonun hangi kenarına (`left | right | top | bottom`)
 * denk geldiğini ve önizleme dikdörtgenini hesaplar.
 */
export function resolveMainDropTarget(
  point: { x: number; y: number } | null,
  draggedTaskId?: string | null
): MainDropHit | null {
  if (!point || typeof document === 'undefined') return null;
  const zone = document.querySelector(`[${MAIN_DROP_ZONE_ATTRIBUTE}]`);
  if (!zone) return null;
  const mainRect = zone.getBoundingClientRect();
  if (
    point.x < mainRect.left ||
    point.x > mainRect.right ||
    point.y < mainRect.top ||
    point.y > mainRect.bottom
  ) {
    return null;
  }

  let hoveredTile: { taskId: string; rect: DOMRect } | null = null;
  const tiles = zone.querySelectorAll<HTMLElement>('[data-testid="board-tile"]');
  for (const tile of tiles) {
    const taskId = tile.dataset.taskId;
    if (!taskId || (draggedTaskId && taskId === draggedTaskId)) continue;
    const rect = tile.getBoundingClientRect();
    if (
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom
    ) {
      hoveredTile = { taskId, rect };
      break;
    }
  }

  const targetRect = hoveredTile ? hoveredTile.rect : mainRect;
  const side = nearestQuadSide(point, targetRect);
  return {
    side,
    ...(hoveredTile ? { targetTaskId: hoveredTile.taskId } : {}),
    previewRect: halfPreviewRect(side, targetRect, mainRect),
  };
}

class BoardDragStore {
  droppable = false;
  overMain = false;
  dragLabel: string | null = null;
  draggedTaskId: string | null = null;
  pointer: { x: number; y: number } | null = null;
  hit: MainDropHit | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  start(
    droppable: boolean,
    overMain: boolean,
    dragLabel: string | null = null,
    draggedTaskId: string | null = null
  ): void {
    this.droppable = droppable;
    this.overMain = overMain;
    this.dragLabel = dragLabel;
    this.draggedTaskId = draggedTaskId;
    if (!overMain) this.hit = null;
  }

  setOverMain(overMain: boolean): void {
    if (this.overMain !== overMain) this.overMain = overMain;
    if (!overMain) this.hit = null;
  }

  setPointer(pointer: { x: number; y: number } | null): void {
    this.pointer = pointer;
  }

  updatePoint(point: { x: number; y: number } | null): void {
    this.pointer = point;
    const nextHit = this.droppable ? resolveMainDropTarget(point, this.draggedTaskId) : null;
    this.hit = nextHit;
    this.overMain = nextHit !== null;
  }

  reset(): void {
    this.droppable = false;
    this.overMain = false;
    this.dragLabel = null;
    this.draggedTaskId = null;
    this.pointer = null;
    this.hit = null;
  }

  get showOverlay(): boolean {
    return this.droppable && this.overMain;
  }
}

export const boardDragStore = new BoardDragStore();
