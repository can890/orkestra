import { describe, expect, it } from 'vitest';
import {
  WIDGET_HEIGHT_MESSAGE,
  WIDGET_MAX_HEIGHT,
  WIDGET_MIN_HEIGHT,
  clampWidgetHeight,
  parseWidgetHeightMessage,
} from './widget-height';

const frame = { name: 'widget-frame' };
const other = { name: 'someone-else' };
const message = (height: unknown, extra: Record<string, unknown> = {}) => ({
  type: WIDGET_HEIGHT_MESSAGE,
  height,
  ...extra,
});

describe('parseWidgetHeightMessage', () => {
  it('accepts a valid message from the iframe window', () => {
    expect(parseWidgetHeightMessage({ source: frame, data: message(320) }, frame)).toBe(320);
    expect(parseWidgetHeightMessage({ source: frame, data: message(320.4) }, frame)).toBe(320);
  });

  it('ignores messages from any other window', () => {
    expect(parseWidgetHeightMessage({ source: other, data: message(320) }, frame)).toBeNull();
    expect(parseWidgetHeightMessage({ source: null, data: message(320) }, frame)).toBeNull();
    expect(
      parseWidgetHeightMessage({ source: undefined, data: message(320) }, undefined)
    ).toBeNull();
    expect(parseWidgetHeightMessage({ source: null, data: message(320) }, null)).toBeNull();
  });

  it('ignores messages with the wrong schema', () => {
    const parse = (data: unknown) => parseWidgetHeightMessage({ source: frame, data }, frame);
    expect(parse({ type: 'something-else', height: 100 })).toBeNull();
    expect(parse({ height: 100 })).toBeNull();
    expect(parse({ type: WIDGET_HEIGHT_MESSAGE })).toBeNull();
    expect(parse(message('300'))).toBeNull();
    expect(parse(message(null))).toBeNull();
    expect(parse(message(Number.NaN))).toBeNull();
    expect(parse(message(Number.POSITIVE_INFINITY))).toBeNull();
    expect(parse(message(100, { extra: 1 }))).toBeNull();
    expect(parse([WIDGET_HEIGHT_MESSAGE, 100])).toBeNull();
    expect(parse('orkestra-widget-height')).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse(undefined)).toBeNull();
  });

  it('clamps extreme values into the allowed range', () => {
    const parse = (height: number) =>
      parseWidgetHeightMessage({ source: frame, data: message(height) }, frame);
    expect(parse(1_000_000)).toBe(WIDGET_MAX_HEIGHT);
    expect(parse(-50)).toBe(WIDGET_MIN_HEIGHT);
    expect(parse(0)).toBe(WIDGET_MIN_HEIGHT);
    expect(clampWidgetHeight(500)).toBe(500);
  });
});
