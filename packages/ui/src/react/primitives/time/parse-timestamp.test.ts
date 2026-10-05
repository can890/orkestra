import { describe, expect, it } from 'vitest';
import { parseTimestamp } from './parse-timestamp';

describe('parseTimestamp', () => {
  it('treats bare SQLite "YYYY-MM-DD HH:mm:ss" timestamps as UTC', () => {
    const date = parseTimestamp('2026-03-04 16:20:30');
    expect(date).not.toBeNull();
    expect(date!.toISOString()).toBe('2026-03-04T16:20:30.000Z');
  });

  it('does not re-suffix strings that already carry a Z timezone', () => {
    const date = parseTimestamp('2026-03-04T16:20:30Z');
    expect(date!.toISOString()).toBe('2026-03-04T16:20:30.000Z');
  });

  it('respects explicit positive UTC offsets', () => {
    const date = parseTimestamp('2026-03-04T16:20:30+02:00');
    expect(date!.toISOString()).toBe('2026-03-04T14:20:30.000Z');
  });

  it('passes through Date instances unchanged', () => {
    const input = new Date('2026-03-04T16:20:30Z');
    expect(parseTimestamp(input)).toBe(input);
  });

  it('parses epoch-millisecond numbers', () => {
    const date = parseTimestamp(Date.UTC(2026, 2, 4, 16, 20, 30));
    expect(date!.toISOString()).toBe('2026-03-04T16:20:30.000Z');
  });

  it('returns null for empty, whitespace-only, and unparseable input', () => {
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('   ')).toBeNull();
    expect(parseTimestamp('not a date')).toBeNull();
    expect(parseTimestamp(Number.NaN)).toBeNull();
  });
});
