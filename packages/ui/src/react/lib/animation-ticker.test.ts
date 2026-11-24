import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANIMATION_TICK_MS,
  animationTickerState,
  subscribeAnimationTicker,
} from './animation-ticker';

describe('animation ticker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shares one timer between subscribers and stops when the last one leaves', () => {
    const a: number[] = [];
    const b: number[] = [];
    const offA = subscribeAnimationTicker((tick) => a.push(tick));
    const offB = subscribeAnimationTicker((tick) => b.push(tick));
    expect(animationTickerState()).toEqual({ running: true, listeners: 2 });
    // Yeni abone hemen mevcut tıkla çağrılır.
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    vi.advanceTimersByTime(ANIMATION_TICK_MS * 3);
    expect(a).toHaveLength(4);
    expect(b).toHaveLength(4);
    // İki abone aynı fazı görür.
    expect(a.at(-1)).toBe(b.at(-1));

    offA();
    vi.advanceTimersByTime(ANIMATION_TICK_MS);
    expect(a).toHaveLength(4);
    expect(b).toHaveLength(5);

    offB();
    expect(animationTickerState()).toEqual({ running: false, listeners: 0 });
    vi.advanceTimersByTime(ANIMATION_TICK_MS * 4);
    expect(b).toHaveLength(5);
  });

  it('does not tick while the window is hidden', () => {
    const ticks: number[] = [];
    vi.stubGlobal('document', { hidden: true });
    const off = subscribeAnimationTicker((tick) => ticks.push(tick));
    vi.advanceTimersByTime(ANIMATION_TICK_MS * 5);
    expect(ticks).toHaveLength(1);
    vi.stubGlobal('document', { hidden: false });
    vi.advanceTimersByTime(ANIMATION_TICK_MS * 2);
    expect(ticks).toHaveLength(3);
    off();
  });

  it('runs at most eight updates per second', () => {
    expect(1000 / ANIMATION_TICK_MS).toBeLessThanOrEqual(8);
  });
});
