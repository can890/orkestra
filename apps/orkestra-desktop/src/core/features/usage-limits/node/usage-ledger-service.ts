import { eq, like } from 'drizzle-orm';
import { z } from 'zod';
import type {
  UsageLedgerDaySummary,
  UsageLedgerProviderSummary,
  UsageLedgerRecordInput,
  UsageLedgerSummary,
} from '@core/features/usage-limits/api/usage-limits';
import type { AppDb, DrizzleTx } from '@core/services/app-db/node/db';
import { kv } from '@core/services/app-db/node/schema';

const LEDGER_DAY_PREFIX = 'usage:ledger:daily:';
const LEDGER_CONV_PREFIX = 'usage:ledger:conv:';
const MAX_RETENTION_DAYS = 90;

const conversationLedgerSchema = z.object({
  version: z.literal(1),
  providerId: z.string(),
  model: z.string().optional(),
  turns: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type ConversationLedgerEntry = z.infer<typeof conversationLedgerSchema>;

const bucketEntrySchema = z.object({
  turns: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});

const dailyBucketSchema = z.object({
  version: z.literal(1),
  date: z.string(),
  providers: z.record(
    z.string(),
    bucketEntrySchema.extend({
      models: z.record(z.string(), bucketEntrySchema).optional(),
    })
  ),
});

type DailyBucket = z.infer<typeof dailyBucketSchema>;

export function toUtcDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dayKey(dateKey: string): string {
  return `${LEDGER_DAY_PREFIX}${dateKey}`;
}

function parseBucket(raw: string): DailyBucket | null {
  try {
    const parsed = dailyBucketSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function cutoffDateKey(nowMs: number, rangeDays: number): string {
  const safeDays = Math.max(1, Math.min(MAX_RETENTION_DAYS, Math.trunc(rangeDays)));
  const start = new Date(nowMs);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (safeDays - 1));
  return toUtcDateKey(start);
}

/**
 * Sohbetlerden gelen tur, token artışı ve tahmini maliyet verilerini SQLite `kv` tablosunda
 * günlük kovalar (`usage:ledger:daily:YYYY-MM-DD`) halinde saklar (en fazla 90 gün).
 */
export class UsageLedgerService {
  private readonly now: () => number;

  constructor(
    private readonly db: AppDb,
    options: { now?: () => number } = {}
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  record(input: UsageLedgerRecordInput): { ok: boolean } {
    const turns = Math.max(0, Math.trunc(input.turnsDelta ?? 0));
    const tokens = Math.max(0, Math.trunc(input.tokensDelta ?? 0));
    const costUsd =
      typeof input.costUsdDelta === 'number' && Number.isFinite(input.costUsdDelta)
        ? Math.max(0, input.costUsdDelta)
        : 0;

    if (turns === 0 && tokens === 0 && costUsd === 0) {
      return { ok: true };
    }

    const nowMs = this.now();
    const today = toUtcDateKey(new Date(nowMs));
    const key = dayKey(today);
    const providerId = input.providerId.trim();
    if (!providerId) return { ok: false };
    const modelId = input.model?.trim() || null;

    this.db.transaction((tx) => {
      const existingRow = tx.select({ value: kv.value }).from(kv).where(eq(kv.key, key)).get();
      const bucket: DailyBucket = (existingRow ? parseBucket(existingRow.value) : null) ?? {
        version: 1,
        date: today,
        providers: {},
      };

      const prevProvider = bucket.providers[providerId] ?? {
        turns: 0,
        tokens: 0,
        costUsd: 0,
        models: {},
      };
      const models = { ...(prevProvider.models ?? {}) };
      if (modelId) {
        const prevModel = models[modelId] ?? { turns: 0, tokens: 0, costUsd: 0 };
        models[modelId] = {
          turns: prevModel.turns + turns,
          tokens: prevModel.tokens + tokens,
          costUsd: prevModel.costUsd + costUsd,
        };
      }

      bucket.providers[providerId] = {
        turns: prevProvider.turns + turns,
        tokens: prevProvider.tokens + tokens,
        costUsd: prevProvider.costUsd + costUsd,
        models,
      };

      this.upsertKv(tx, key, JSON.stringify(bucket), Math.floor(nowMs / 1000));

      const convId = input.conversationId?.trim();
      if (convId) {
        const convKey = `${LEDGER_CONV_PREFIX}${convId}`;
        const existingConvRow = tx
          .select({ value: kv.value })
          .from(kv)
          .where(eq(kv.key, convKey))
          .get();
        let prevConv: ConversationLedgerEntry | null = null;
        if (existingConvRow) {
          try {
            const parsed = conversationLedgerSchema.safeParse(JSON.parse(existingConvRow.value));
            if (parsed.success) prevConv = parsed.data;
          } catch {
            prevConv = null;
          }
        }
        const nextConv: ConversationLedgerEntry = {
          version: 1,
          providerId,
          ...(modelId ? { model: modelId } : prevConv?.model ? { model: prevConv.model } : {}),
          turns: (prevConv?.turns ?? 0) + turns,
          tokens: (prevConv?.tokens ?? 0) + tokens,
          costUsd: (prevConv?.costUsd ?? 0) + costUsd,
          updatedAt: Math.trunc(nowMs),
        };
        this.upsertKv(tx, convKey, JSON.stringify(nextConv), Math.floor(nowMs / 1000));
      }
    });

    this.pruneOldBuckets(nowMs);
    return { ok: true };
  }

  getConversation(conversationId: string): ConversationLedgerEntry | null {
    const convId = conversationId.trim();
    if (!convId) return null;
    try {
      const row = this.db
        .select({ value: kv.value })
        .from(kv)
        .where(eq(kv.key, `${LEDGER_CONV_PREFIX}${convId}`))
        .get();
      if (!row) return null;
      const parsed = conversationLedgerSchema.safeParse(JSON.parse(row.value));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  getSummary(rangeDays = 30): UsageLedgerSummary {
    const clampedRange = Math.max(1, Math.min(MAX_RETENTION_DAYS, Math.trunc(rangeDays)));
    const cutoff = cutoffDateKey(this.now(), clampedRange);
    const rows = this.db
      .select({ key: kv.key, value: kv.value })
      .from(kv)
      .where(like(kv.key, `${LEDGER_DAY_PREFIX}%`))
      .all();

    const totals = { turns: 0, tokens: 0, costUsd: 0 };
    const providerMap = new Map<string, UsageLedgerProviderSummary>();
    const dayList: UsageLedgerDaySummary[] = [];

    for (const row of rows) {
      const dateStr = row.key.slice(LEDGER_DAY_PREFIX.length);
      if (!dateStr || dateStr < cutoff) continue;
      const bucket = parseBucket(row.value);
      if (!bucket) continue;

      let dayTurns = 0;
      let dayTokens = 0;
      let dayCost = 0;

      for (const [providerId, entry] of Object.entries(bucket.providers)) {
        dayTurns += entry.turns;
        dayTokens += entry.tokens;
        dayCost += entry.costUsd;

        totals.turns += entry.turns;
        totals.tokens += entry.tokens;
        totals.costUsd += entry.costUsd;

        const cur = providerMap.get(providerId) ?? {
          providerId,
          turns: 0,
          tokens: 0,
          costUsd: 0,
        };
        cur.turns += entry.turns;
        cur.tokens += entry.tokens;
        cur.costUsd += entry.costUsd;
        providerMap.set(providerId, cur);
      }

      dayList.push({
        date: bucket.date,
        turns: dayTurns,
        tokens: dayTokens,
        costUsd: dayCost,
      });
    }

    const byProvider = Array.from(providerMap.values()).sort((a, b) => {
      if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
      if (b.tokens !== a.tokens) return b.tokens - a.tokens;
      return b.turns - a.turns;
    });

    const byDay = dayList.sort((a, b) => a.date.localeCompare(b.date));

    return {
      rangeDays: clampedRange,
      totals,
      byProvider,
      byDay,
    };
  }

  clear(): { ok: boolean } {
    this.db
      .delete(kv)
      .where(like(kv.key, `${LEDGER_DAY_PREFIX}%`))
      .run();
    return { ok: true };
  }

  private pruneOldBuckets(nowMs: number): void {
    const oldestAllowed = cutoffDateKey(nowMs, MAX_RETENTION_DAYS);
    const rows = this.db
      .select({ key: kv.key })
      .from(kv)
      .where(like(kv.key, `${LEDGER_DAY_PREFIX}%`))
      .all();

    for (const row of rows) {
      const dateStr = row.key.slice(LEDGER_DAY_PREFIX.length);
      if (dateStr && dateStr < oldestAllowed) {
        this.db.delete(kv).where(eq(kv.key, row.key)).run();
      }
    }
  }

  private upsertKv(
    target: AppDb | DrizzleTx,
    key: string,
    value: string,
    updatedAtSeconds: number
  ): void {
    (target as AppDb)
      .insert(kv)
      .values({ key, value, updatedAt: updatedAtSeconds })
      .onConflictDoUpdate({
        target: kv.key,
        set: { value, updatedAt: updatedAtSeconds },
      })
      .run();
  }
}
