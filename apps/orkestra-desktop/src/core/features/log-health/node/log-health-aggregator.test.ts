import { describe, expect, it } from 'vitest';
import { LogHealthAggregator } from './log-health-aggregator';
import type { ParsedLogEntry } from './log-line-parser';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const SESSION_START = NOW - 60 * 60 * 1000;
// GitHub erişim belirteci biçiminde sahte değer: redactAll tarafından yakalanır.
const VENDOR_TOKEN = `ghp_${'a'.repeat(36)}`;

function entry(overrides: Partial<ParsedLogEntry> = {}): ParsedLogEntry {
  return {
    level: 'warn',
    time: NOW - 1000,
    proc: 'orkestra-main',
    pid: 100,
    message: 'notifications: prune failed',
    error: { name: 'SqliteError', message: 'no such column: x', stack: null, code: null },
    extra: {},
    ...overrides,
  };
}

function aggregator(maxGroups = 50) {
  return new LogHealthAggregator({
    windowMs: 7 * DAY,
    maxGroups,
    sessionStartedAt: SESSION_START,
    now: () => NOW,
  });
}

describe('LogHealthAggregator', () => {
  it('yalnızca kimliği değişen tekrarları tek grupta toplar', () => {
    const agg = aggregator();
    agg.ingest(entry({ message: 'Task 0668f948-d6fd-4c4f-9bb5-2c1a7e8d8938 failed in 120ms' }));
    agg.ingest(entry({ message: 'Task 118f0607-8a74-465b-8d76-f4f613e3b85b failed in 98ms' }));
    agg.ingest(entry({ message: 'Something else' }));
    const groups = agg.snapshot();
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ template: 'Task <id> failed in <n>ms', count: 2 });
  });

  it('oturum, açılış ve gün sayılarını ayrı izler', () => {
    const agg = aggregator();
    agg.ingest(entry({ time: NOW - 3 * DAY, pid: 1 }));
    agg.ingest(entry({ time: NOW - 2 * DAY, pid: 2 }));
    agg.ingest(entry({ time: NOW - 1000, pid: 3 }));
    agg.ingest(entry({ time: NOW - 500, pid: 3, proc: 'renderer' }));
    const [group] = agg.snapshot();
    expect(group).toMatchObject({
      count: 4,
      sessionCount: 2,
      launchCount: 3,
      dayCount: 3,
      firstSeen: NOW - 3 * DAY,
      lastSeen: NOW - 500,
      processes: ['orkestra-main', 'renderer'],
    });
  });

  it('farklı hata imzalarını ve seviyeleri ayırır, önem ve sıklığa göre sıralar', () => {
    const agg = aggregator();
    agg.ingest(entry());
    agg.ingest(entry());
    agg.ingest(
      entry({ error: { name: 'TypeError', message: 'x is undefined', stack: null, code: null } })
    );
    agg.ingest(entry({ level: 'error' }));
    const groups = agg.snapshot();
    expect(groups.map((group) => [group.level, group.count])).toEqual([
      ['error', 1],
      ['warn', 2],
      ['warn', 1],
    ]);
  });

  it('pencere dışındaki kayıtları almaz ve eski grupları budar', () => {
    let now = NOW;
    const agg = new LogHealthAggregator({
      windowMs: 7 * DAY,
      maxGroups: 50,
      sessionStartedAt: SESSION_START,
      now: () => now,
    });
    expect(agg.ingest(entry({ time: NOW - 8 * DAY }))).toBe(false);
    agg.ingest(entry({ time: NOW - 6 * DAY }));
    expect(agg.size).toBe(1);
    now = NOW + 2 * DAY;
    expect(agg.prune()).toBe(true);
    expect(agg.size).toBe(0);
  });

  it('grup sınırı aşılınca en uzun süredir görülmeyeni düşürür', () => {
    const agg = aggregator(2);
    agg.ingest(entry({ message: 'a', time: NOW - 3000 }));
    agg.ingest(entry({ message: 'b', time: NOW - 2000 }));
    agg.ingest(entry({ message: 'c', time: NOW - 1000 }));
    expect(
      agg
        .snapshot()
        .map((group) => group.template)
        .sort()
    ).toEqual(['b', 'c']);
  });

  it('son örneği tutar ve tüm alanları yeniden maskeler', () => {
    const agg = aggregator();
    agg.ingest(entry({ message: 'first' }));
    agg.ingest(
      entry({
        time: NOW - 10,
        message: `auth failed token=${VENDOR_TOKEN}`,
        error: {
          name: 'Error',
          message: `bad ${VENDOR_TOKEN} for person@example.com`,
          stack: `Error: bad\n    at /Users/selim/app.js:1:1`,
          code: null,
        },
        extra: { apiKey: 'plain-secret', path: '/Users/selim/project' },
      })
    );
    const [group] = agg.snapshot();
    const serialized = JSON.stringify(group);
    expect(serialized).not.toContain(VENDOR_TOKEN);
    expect(serialized).not.toContain('person@example.com');
    expect(serialized).not.toContain('/Users/selim');
    expect(serialized).not.toContain('plain-secret');
    expect(group?.template).toBe('auth failed token=[REDACTED]');
    expect(group?.example.errorMessage).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(group?.example.fields).toContain('/Users/[REDACTED_USER]');
  });
});
