import { describe, expect, it } from 'vitest';
import { formatRelativeMessageTime } from './format-time';

describe('formatRelativeMessageTime', () => {
  const now = new Date(2026, 10, 25, 17, 0, 0).getTime();
  const ago = (ms: number) => formatRelativeMessageTime(now - ms, now);

  it('uses Turkish relative wording like the Claude app', () => {
    expect(ago(10_000)).toBe('şimdi');
    expect(ago(-5_000)).toBe('şimdi');
    expect(ago(60_000)).toBe('1 dakika önce');
    expect(ago(15 * 60_000 + 30_000)).toBe('15 dakika önce');
    expect(ago(3 * 3_600_000)).toBe('3 saat önce');
    expect(ago(2 * 86_400_000)).toBe('2 gün önce');
  });

  it('falls back to a date after a week, with the year only when it differs', () => {
    expect(ago(10 * 86_400_000)).toMatch(/^15 Kas/);
    expect(formatRelativeMessageTime(new Date(2025, 0, 3).getTime(), now)).toMatch(
      /^3 Oca.* 2025$/
    );
  });

  it('returns null for missing or invalid timestamps', () => {
    expect(formatRelativeMessageTime(undefined, now)).toBeNull();
    expect(formatRelativeMessageTime(0, now)).toBeNull();
    expect(formatRelativeMessageTime(Number.NaN, now)).toBeNull();
  });
});
