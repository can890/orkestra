import { describe, expect, it } from 'vitest';
import type { LogHealthGroup } from './contract';
import { formatLogHealthSummary } from './summary';

const VENDOR_TOKEN = `ghp_${'c'.repeat(36)}`;

const group: LogHealthGroup = {
  key: 'k1',
  level: 'error',
  template: 'notifications: prune failed',
  errorSignature: 'SqliteError: no such column: kind',
  count: 12,
  sessionCount: 1,
  launchCount: 12,
  dayCount: 6,
  firstSeen: Date.parse('2026-10-01T00:00:00.000Z'),
  lastSeen: Date.parse('2026-10-06T00:00:00.000Z'),
  processes: ['orkestra-main'],
  example: {
    time: '2026-10-06T00:00:00.000Z',
    proc: 'orkestra-main',
    message: `prune failed ${VENDOR_TOKEN}`,
    errorName: 'SqliteError',
    errorMessage: 'no such column: kind',
    stack: 'SqliteError: no such column: kind\n    at prune (/Users/selim/x.js:1:1)',
    fields: null,
  },
};

describe('formatLogHealthSummary', () => {
  it('okunur bir özet üretir ve son bir kez maskeler', () => {
    const text = formatLogHealthSummary(
      [group],
      {
        logFilePath: '/Users/selim/Library/Application Support/orkestra/logs/orkestra.log',
        windowDays: 7,
      },
      new Date('2026-10-06T12:00:00.000Z')
    );
    expect(text).toContain('Orkestra günlük sağlığı özeti');
    expect(text).toContain('1. [HATA] notifications: prune failed');
    expect(text).toContain('Sayı: 12 (bu oturumda 1, 12 açılış, 6 gün)');
    expect(text).toContain('Hata: SqliteError: no such column: kind');
    expect(text).not.toContain(VENDOR_TOKEN);
    expect(text).not.toContain('/Users/selim');
  });
});
