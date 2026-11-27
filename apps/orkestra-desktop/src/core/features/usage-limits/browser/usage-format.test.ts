import { describe, expect, it } from 'vitest';
import {
  formatMeasuredAgo,
  formatResetCreditExpiry,
  formatResetsIn,
  formatUsageDuration,
  formatUsagePercent,
  getActiveResetCredits,
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

  it('formats reset credit expiry and selects earliest active credit', () => {
    expect(formatResetCreditExpiry(undefined, NOW)).toBeNull();
    expect(formatResetCreditExpiry(new Date(NOW - MIN).toISOString(), NOW)).toBe('Süresi doldu');
    const formatted = formatResetCreditExpiry(
      new Date(NOW + 10 * 24 * 60 * MIN).toISOString(),
      NOW
    );
    expect(formatted).toContain('10 gün kaldı');

    const summary = getActiveResetCredits(
      {
        providerId: 'codex',
        status: 'available',
        windows: [],
        balances: [],
        resetCredits: {
          availableCount: 2,
          canRedeem: true,
          credits: [
            {
              id: 'expired',
              expiresAt: new Date(NOW - MIN).toISOString(),
              status: 'available',
            },
            {
              id: 'later',
              expiresAt: new Date(NOW + 20 * 24 * 60 * MIN).toISOString(),
              status: 'available',
            },
            {
              id: 'soonest',
              expiresAt: new Date(NOW + 3 * 24 * 60 * MIN).toISOString(),
              status: 'available',
            },
          ],
        },
        source: 'Codex CLI',
        measuredAt: new Date(NOW).toISOString(),
        fetchedAt: NOW,
      },
      NOW
    );
    expect(summary.count).toBe(2);
    expect(summary.canRedeem).toBe(true);
    expect(summary.nextExpiring?.id).toBe('soonest');
    expect(summary.credits.map((c) => c.id)).toEqual(['soonest', 'later']);
  });
});
