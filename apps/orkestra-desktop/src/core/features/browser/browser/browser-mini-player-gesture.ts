// Adapted from pingdotgg/t3code (MIT) — pointer drag/resize state machine for mini-player.
import type { MiniPlayerPosition } from '@core/features/browser/api/browser/browser-mini-player-store';
import {
  clampMiniPlayerPosition,
  resizeMiniPlayerFrame,
  type MiniPlayerContainerSize,
  type MiniPlayerFrame,
  type ResizeDirection,
} from './browser-mini-player-layout';

export type MiniPlayerGesture = {
  pointerId: number;
  pointerType: string;
  direction: ResizeDirection | null;
  startClientX: number;
  startClientY: number;
  startFrame: MiniPlayerFrame;
  moved: boolean;
};

export type MiniPlayerGestureStep =
  | { kind: 'ignore' }
  | { kind: 'end' }
  | { kind: 'move'; position: MiniPlayerPosition }
  | { kind: 'resize'; frame: MiniPlayerFrame };

export function startMiniPlayerGesture(
  event: { pointerId: number; pointerType: string; clientX: number; clientY: number },
  direction: ResizeDirection | null,
  startFrame: MiniPlayerFrame
): MiniPlayerGesture {
  return {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    direction,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startFrame,
    moved: false,
  };
}

export function stepMiniPlayerGesture(
  gesture: MiniPlayerGesture,
  event: { pointerId: number; buttons: number; clientX: number; clientY: number },
  container: MiniPlayerContainerSize
): MiniPlayerGestureStep {
  if (gesture.pointerId !== event.pointerId) return { kind: 'ignore' };
  if (event.buttons === 0) return { kind: 'end' };

  const dx = event.clientX - gesture.startClientX;
  const dy = event.clientY - gesture.startClientY;

  if (gesture.direction === null) {
    const position = clampMiniPlayerPosition(
      {
        x: gesture.startFrame.x + dx,
        y: gesture.startFrame.y + dy,
      },
      { width: gesture.startFrame.width, height: gesture.startFrame.height },
      container
    );
    return { kind: 'move', position };
  }

  return {
    kind: 'resize',
    frame: resizeMiniPlayerFrame(gesture.startFrame, gesture.direction, dx, dy, container),
  };
}
