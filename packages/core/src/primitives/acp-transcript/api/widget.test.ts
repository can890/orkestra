import { describe, expect, it } from 'vitest';
import {
  WIDGET_MAX_BYTES,
  WIDGET_MAX_TITLE_LENGTH,
  extractWidgetInput,
  isWidgetMcpCall,
  isWidgetToolName,
  validateWidgetInput,
} from './widget';

describe('validateWidgetInput', () => {
  it('accepts a title with html', () => {
    expect(validateWidgetInput({ title: ' Grafik ', html: '<p>merhaba</p>' })).toEqual({
      success: true,
      data: { title: 'Grafik', html: '<p>merhaba</p>' },
    });
  });

  it('accepts a title with svg', () => {
    expect(validateWidgetInput({ title: 'Daire', svg: '<svg></svg>' })).toEqual({
      success: true,
      data: { title: 'Daire', svg: '<svg></svg>' },
    });
  });

  it('requires exactly one of html and svg', () => {
    expect(validateWidgetInput({ title: 'x' }).success).toBe(false);
    expect(validateWidgetInput({ title: 'x', html: '<p/>', svg: '<svg/>' }).success).toBe(false);
  });

  it('rejects empty or oversized titles and non-string titles', () => {
    expect(validateWidgetInput({ title: '   ', html: '<p/>' }).success).toBe(false);
    expect(
      validateWidgetInput({ title: 'a'.repeat(WIDGET_MAX_TITLE_LENGTH + 1), html: '<p/>' })
    ).toEqual(expect.objectContaining({ success: false }));
    expect(
      validateWidgetInput({ title: 'a'.repeat(WIDGET_MAX_TITLE_LENGTH), html: '<p/>' }).success
    ).toBe(true);
    expect(validateWidgetInput({ title: 5, html: '<p/>' }).success).toBe(false);
  });

  it('rejects empty and non-string content', () => {
    expect(validateWidgetInput({ title: 'x', html: '  ' }).success).toBe(false);
    expect(validateWidgetInput({ title: 'x', html: 42 }).success).toBe(false);
    expect(validateWidgetInput({ title: 'x', svg: { a: 1 } }).success).toBe(false);
  });

  it('limits the total size in bytes, not characters', () => {
    const fits = 'a'.repeat(WIDGET_MAX_BYTES - 1);
    expect(validateWidgetInput({ title: 'x', html: fits }).success).toBe(true);
    expect(validateWidgetInput({ title: 'x', html: fits + 'a' }).success).toBe(false);
    // Her "ş" 2 bayttır: karakter sayısı sınırın altında, bayt sayısı üstünde.
    const multibyte = 'ş'.repeat(WIDGET_MAX_BYTES / 2);
    expect(validateWidgetInput({ title: 'x', html: multibyte }).success).toBe(false);
  });

  it('rejects non-object input', () => {
    for (const value of [null, undefined, 'x', 1, [], [{ title: 'x', html: 'y' }]]) {
      expect(validateWidgetInput(value).success).toBe(false);
    }
  });
});

describe('widget tool detection', () => {
  it('recognizes provider spellings', () => {
    expect(isWidgetToolName('mcp__orkestra-widgets__show_widget')).toBe(true);
    expect(isWidgetToolName('mcp.orkestra-widgets.show_widget')).toBe(true);
    expect(isWidgetToolName('show_widget')).toBe(false);
    expect(isWidgetToolName('mcp__orkestra__show_widget')).toBe(false);
    expect(isWidgetToolName('mcp__orkestra-widgets__other')).toBe(false);
    expect(isWidgetToolName(undefined)).toBe(false);
  });

  it('checks server and tool when they arrive separately', () => {
    expect(isWidgetMcpCall({ server: 'orkestra-widgets', tool: 'show_widget' })).toBe(true);
    expect(isWidgetMcpCall({ server: 'other', tool: 'show_widget' })).toBe(false);
    expect(isWidgetMcpCall({ server: 'orkestra-widgets', tool: 'other' })).toBe(false);
    expect(isWidgetMcpCall({ tool: 'mcp__orkestra-widgets__show_widget' })).toBe(true);
  });
});

describe('extractWidgetInput', () => {
  it('reads direct and wrapped arguments', () => {
    const input = { title: 'T', html: '<b>x</b>' };
    expect(extractWidgetInput(input)).toEqual(input);
    expect(
      extractWidgetInput({ server: 'orkestra-widgets', tool: 'show_widget', arguments: input })
    ).toEqual(input);
  });

  it('ignores invalid input', () => {
    expect(extractWidgetInput({})).toBeUndefined();
    expect(extractWidgetInput({ arguments: { title: 'T' } })).toBeUndefined();
    expect(extractWidgetInput(null)).toBeUndefined();
    expect(extractWidgetInput('x')).toBeUndefined();
  });
});
