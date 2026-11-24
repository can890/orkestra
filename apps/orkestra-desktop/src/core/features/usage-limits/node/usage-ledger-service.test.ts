import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '@core/services/app-db/node/db';
import { kv } from '@core/services/app-db/node/schema';
import { UsageLedgerService } from './usage-ledger-service';

describe('UsageLedgerService', () => {
  let sqlite: Database.Database;
  let db: AppDb;
  let nowMs: number;
  let service: UsageLedgerService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE kv (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX idx_kv_key ON kv (key);
    `);
    db = drizzle(sqlite, { schema: { kv } }) as unknown as AppDb;
    nowMs = Date.UTC(2026, 10, 24, 12, 0, 0);
    service = new UsageLedgerService(db, { now: () => nowMs });
  });

  afterEach(() => {
    sqlite.close();
  });

  it('aggregates turns, tokens, and cost per provider across days and respects rangeDays', () => {
    service.record({
      conversationId: 'c1',
      providerId: 'claude',
      model: 'claude-sonnet',
      turnsDelta: 1,
      tokensDelta: 1200,
      costUsdDelta: 0.04,
    });
    service.record({
      conversationId: 'c1',
      providerId: 'claude',
      model: 'claude-sonnet',
      turnsDelta: 0,
      tokensDelta: 800,
      costUsdDelta: 0.03,
    });
    service.record({
      conversationId: 'c2',
      providerId: 'codex',
      turnsDelta: 2,
      tokensDelta: 500,
      costUsdDelta: 0.01,
    });

    // 10 gün öncesine de bir kayıt yazalım.
    nowMs = Date.UTC(2026, 10, 14, 12, 0, 0);
    service.record({
      conversationId: 'c3',
      providerId: 'claude',
      turnsDelta: 3,
      tokensDelta: 3000,
      costUsdDelta: 0.12,
    });

    // Bugüne dönüp 7 günlük ve 30 günlük özetleri kontrol et.
    nowMs = Date.UTC(2026, 10, 24, 15, 0, 0);

    const sevenDay = service.getSummary(7);
    expect(sevenDay.totals.turns).toBe(3);
    expect(sevenDay.totals.tokens).toBe(2500);
    expect(sevenDay.totals.costUsd).toBeCloseTo(0.08, 6);
    expect(sevenDay.byProvider.map((p) => p.providerId)).toEqual(['claude', 'codex']);
    expect(sevenDay.byDay).toHaveLength(1);

    const thirtyDay = service.getSummary(30);
    expect(thirtyDay.totals.turns).toBe(6);
    expect(thirtyDay.totals.tokens).toBe(5500);
    expect(thirtyDay.totals.costUsd).toBeCloseTo(0.2, 6);
    expect(thirtyDay.byDay.map((d) => d.date)).toEqual(['2026-11-14', '2026-11-24']);
  });

  it('ignores zero-delta writes and clears all ledger entries on clear()', () => {
    expect(
      service.record({
        conversationId: 'c1',
        providerId: 'claude',
        turnsDelta: 0,
        tokensDelta: 0,
        costUsdDelta: 0,
      })
    ).toEqual({ ok: true });
    expect(service.getSummary(30).totals).toEqual({ turns: 0, tokens: 0, costUsd: 0 });

    service.record({
      conversationId: 'c1',
      providerId: 'antigravity',
      turnsDelta: 1,
      tokensDelta: 400,
      costUsdDelta: 0.02,
    });
    expect(service.getSummary(1).totals.turns).toBe(1);

    service.clear();
    expect(service.getSummary(30)).toEqual({
      rangeDays: 30,
      totals: { turns: 0, tokens: 0, costUsd: 0 },
      byProvider: [],
      byDay: [],
    });
  });

  it('prunes buckets older than 90 days automatically on write', () => {
    nowMs = Date.UTC(2026, 5, 1, 10, 0, 0);
    service.record({
      conversationId: 'old',
      providerId: 'claude',
      turnsDelta: 5,
    });

    nowMs = Date.UTC(2026, 10, 24, 10, 0, 0);
    service.record({
      conversationId: 'new',
      providerId: 'claude',
      turnsDelta: 1,
    });

    const summary = service.getSummary(90);
    expect(summary.totals.turns).toBe(1);
    expect(summary.byDay).toHaveLength(1);
    expect(summary.byDay[0]?.date).toBe('2026-11-24');
  });
});
