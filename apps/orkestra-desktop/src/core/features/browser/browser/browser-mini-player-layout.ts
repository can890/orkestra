// Adapted from pingdotgg/t3code (MIT) — floating preview mini-player geometry & clamping.
import {
  MINI_PLAYER_DEFAULT_HEIGHT,
  MINI_PLAYER_DEFAULT_WIDTH,
  MINI_PLAYER_MIN_HEIGHT,
  MINI_PLAYER_MIN_WIDTH,
  type MiniPlayerGeometry,
  type MiniPlayerPosition,
} from '@core/features/browser/api/browser/browser-mini-player-store';

export const MINI_PLAYER_EDGE_MARGIN = 12;
export const MINI_PLAYER_COMPOSER_CLEARANCE = 136;
export const MINI_PLAYER_CORNER_RADIUS = 12;

export type MiniPlayerContainerSize = {
  width: number;
  height: number;
};

export type MiniPlayerFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

function clampNumber(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

export function resolveMiniPlayerFrame(
  geometry: MiniPlayerGeometry,
  container: MiniPlayerContainerSize
): MiniPlayerFrame | null {
  if (container.width <= 0 || container.height <= 0) return null;

  const maxW = Math.max(MINI_PLAYER_MIN_WIDTH, container.width - 2 * MINI_PLAYER_EDGE_MARGIN);
  const maxH = Math.max(MINI_PLAYER_MIN_HEIGHT, container.height - 2 * MINI_PLAYER_EDGE_MARGIN);

  const width = Math.round(
    clampNumber(
      geometry.width || MINI_PLAYER_DEFAULT_WIDTH,
      Math.min(MINI_PLAYER_MIN_WIDTH, maxW),
      maxW
    )
  );
  const height = Math.round(
    clampNumber(
      geometry.height || MINI_PLAYER_DEFAULT_HEIGHT,
      Math.min(MINI_PLAYER_MIN_HEIGHT, maxH),
      maxH
    )
  );

  const defaultX = container.width - width - MINI_PLAYER_EDGE_MARGIN;
  const defaultY = Math.max(
    MINI_PLAYER_EDGE_MARGIN,
    container.height - height - MINI_PLAYER_COMPOSER_CLEARANCE
  );

  const rawX = geometry.x ?? defaultX;
  const rawY = geometry.y ?? defaultY;

  const x = Math.round(
    clampNumber(
      rawX,
      MINI_PLAYER_EDGE_MARGIN,
      Math.max(MINI_PLAYER_EDGE_MARGIN, container.width - width - MINI_PLAYER_EDGE_MARGIN)
    )
  );
  const y = Math.round(
    clampNumber(
      rawY,
      MINI_PLAYER_EDGE_MARGIN,
      Math.max(MINI_PLAYER_EDGE_MARGIN, container.height - height - MINI_PLAYER_EDGE_MARGIN)
    )
  );

  return { x, y, width, height };
}

export function clampMiniPlayerPosition(
  position: MiniPlayerPosition,
  size: { width: number; height: number },
  container: MiniPlayerContainerSize
): MiniPlayerPosition {
  const maxX = Math.max(MINI_PLAYER_EDGE_MARGIN, container.width - size.width - MINI_PLAYER_EDGE_MARGIN);
  const maxY = Math.max(MINI_PLAYER_EDGE_MARGIN, container.height - size.height - MINI_PLAYER_EDGE_MARGIN);
  return {
    x: Math.round(clampNumber(position.x, MINI_PLAYER_EDGE_MARGIN, maxX)),
    y: Math.round(clampNumber(position.y, MINI_PLAYER_EDGE_MARGIN, maxY)),
  };
}

export function resizeMiniPlayerFrame(
  start: MiniPlayerFrame,
  direction: ResizeDirection,
  deltaX: number,
  deltaY: number,
  container: MiniPlayerContainerSize
): MiniPlayerFrame {
  const minW = Math.min(MINI_PLAYER_MIN_WIDTH, Math.max(120, container.width - 2 * MINI_PLAYER_EDGE_MARGIN));
  const minH = Math.min(MINI_PLAYER_MIN_HEIGHT, Math.max(100, container.height - 2 * MINI_PLAYER_EDGE_MARGIN));

  let left = start.x;
  let right = start.x + start.width;
  let top = start.y;
  let bottom = start.y + start.height;

  const minLeft = MINI_PLAYER_EDGE_MARGIN;
  const maxRight = Math.max(minLeft + minW, container.width - MINI_PLAYER_EDGE_MARGIN);
  const minTop = MINI_PLAYER_EDGE_MARGIN;
  const maxBottom = Math.max(minTop + minH, container.height - MINI_PLAYER_EDGE_MARGIN);

  if (direction.includes('w')) {
    left = clampNumber(start.x + deltaX, minLeft, right - minW);
  }
  if (direction.includes('e')) {
    right = clampNumber(start.x + start.width + deltaX, left + minW, maxRight);
  }
  if (direction.includes('n')) {
    top = clampNumber(start.y + deltaY, minTop, bottom - minH);
  }
  if (direction.includes('s')) {
    bottom = clampNumber(start.y + start.height + deltaY, top + minH, maxBottom);
  }

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
}
