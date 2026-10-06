import { describe, expect, it } from 'vitest';
import { cssToWidgetPoint, mouseClickEvents, mouseWheelEvent } from './pointer';

describe('cssToWidgetPoint', () => {
  it('scales CSS pixels by the page zoom factor (DIP = CSS × zoom)', () => {
    expect(cssToWidgetPoint({ x: 360, y: 220 }, 1.5)).toEqual({ x: 540, y: 330 });
    expect(cssToWidgetPoint({ x: 10, y: 20 }, 1)).toEqual({ x: 10, y: 20 });
    expect(cssToWidgetPoint({ x: 100, y: 50 }, 0.5)).toEqual({ x: 50, y: 25 });
  });

  it('falls back to 1 for invalid zoom factors', () => {
    expect(cssToWidgetPoint({ x: 10, y: 20 }, Number.NaN)).toEqual({ x: 10, y: 20 });
    expect(cssToWidgetPoint({ x: 10, y: 20 }, 0)).toEqual({ x: 10, y: 20 });
  });
});

describe('mouseClickEvents', () => {
  it('moves then sends down/up pairs with increasing click counts', () => {
    const events = mouseClickEvents(
      { x: 5, y: 6 },
      { button: 'left', clickCount: 2, modifiers: ['shift'] }
    );
    expect(events.map((event) => [event.type, event.clickCount])).toEqual([
      ['mouseMove', undefined],
      ['mouseDown', 1],
      ['mouseUp', 1],
      ['mouseDown', 2],
      ['mouseUp', 2],
    ]);
    expect(events.every((event) => event.x === 5 && event.y === 6)).toBe(true);
    expect(events[1]).toMatchObject({ button: 'left', modifiers: ['shift'] });
  });
});

describe('mouseWheelEvent', () => {
  it('uses negative deltas to scroll down/right and precise deltas', () => {
    expect(mouseWheelEvent({ x: 1, y: 2 }, 'down', 300)).toMatchObject({
      deltaX: 0,
      deltaY: -300,
      hasPreciseScrollingDeltas: true,
    });
    expect(mouseWheelEvent({ x: 1, y: 2 }, 'up', 300).deltaY).toBe(300);
    expect(mouseWheelEvent({ x: 1, y: 2 }, 'right', 40).deltaX).toBe(-40);
    expect(mouseWheelEvent({ x: 1, y: 2 }, 'left', 40).deltaX).toBe(40);
  });
});
