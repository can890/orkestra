import { describe, expect, it } from 'vitest';
import {
  formatMeasuredAgo,
  formatResetsIn,
  formatUsageDuration,
  formatUsagePercent,
  usageProviderName,
} from './usage-format';

const NOW = Date.parse('2026-10-06T00:00:00Z');
const MIN = 60_000;

describe('usage format', () => {
  it('formats durations in short Turkish units', () => {
    expect(formatUsageDuration(20_000)).toBe('1 dk’dan az');
    expect(formatUsageDuration(45 * MIN)).toBe('45 dk');
    expect(formatUsageDuration(135 * MIN)).toBe('2 sa 15 dk');
    expect(formatUsageDuration(120 * MIN)).toBe('2 sa');
    expect(formatUsageDuration((3 * 24 + 4) * 60 * MIN)).toBe('3 gün 4 sa');
    expect(formatUsageDuration(2 * 24 * 60 * MIN)).toBe('2 gün');
  });

  it('describes reset times relative to now', () => {
    expect(formatResetsIn(new Date(NOW + 90 * MIN).toISOString(), NOW)).toBe(
      '1 sa 30 dk sonra yenilenir'
    );
    expect(formatResetsIn(new Date(NOW - MIN).toISOString(), NOW)).toBe(
      'Yenilendi, yeni ölçüm bekleniyor'
    );
    expect(formatResetsIn(undefined, NOW)).toBeNull();
    expect(formatResetsIn('not a date', NOW)).toBeNull();
  });

  it('describes measurement age', () => {
    expect(formatMeasuredAgo(new Date(NOW - 10_000).toISOString(), NOW)).toBe('az önce');
    expect(formatMeasuredAgo(new Date(NOW - 12 * MIN).toISOString(), NOW)).toBe('12 dk önce');
  });

  it('names providers and percentages', () => {
    expect(usageProviderName('claude')).toBe('Claude');
    expect(usageProviderName('custom')).toBe('custom');
    expect(formatUsagePercent(97.6)).toBe('%98');
  });
});
