import { log } from '@orkestra/shared/logger';
import { eq, like } from 'drizzle-orm';
import type { AppDb, DrizzleTx } from '@core/services/app-db/node/db';
import { kv } from '@core/services/app-db/node/schema';
import {
  handoffBulkImportInputSchema,
  handoffChainSegmentSchema,
  handoffListAllOutputSchema,
  handoffModeSchema,
  handoffRecordSchema,
  type HandoffBulkImportInput,
  type HandoffChainSegment,
  type HandoffListAllOutput,
  type HandoffMode,
  type HandoffRecord,
} from '../api/handoff-schemas';

const RECORD_PREFIX = 'handoff:record:';
const SUPERSEDED_PREFIX = 'handoff:superseded:';

export {
  handoffBulkImportInputSchema,
  handoffChainSegmentSchema,
  handoffListAllOutputSchema,
  handoffModeSchema,
  handoffRecordSchema,
  type HandoffBulkImportInput,
  type HandoffChainSegment,
  type HandoffListAllOutput,
  type HandoffMode,
  type HandoffRecord,
};

function recordKey(conversationId: string): string {
  return `${RECORD_PREFIX}${conversationId}`;
}

function supersededKey(oldConversationId: string): string {
  return `${SUPERSEDED_PREFIX}${oldConversationId}`;
}

function parseRecordJson(raw: string): HandoffRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = handoffRecordSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function unixNowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Sohbet devir ve çatallama kayıtlarını mevcut SQLite `kv` tablosunda kalıcı olarak saklar.
 * Tüm kayıtlar `handoff:record:<id>` ve `handoff:superseded:<eskiId>` anahtarlarıyla tutulur.
 */
export class HandoffPersistenceService {
  constructor(private readonly db: AppDb) {}

  async listAll(): Promise<HandoffListAllOutput> {
    const rows = this.db
      .select({ key: kv.key, value: kv.value })
      .from(kv)
      .where(like(kv.key, 'handoff:%'))
      .all();

    const records: Array<[string, HandoffRecord]> = [];
    const superseded: Array<[string, string]> = [];

    for (const row of rows) {
      if (row.key.startsWith(RECORD_PREFIX)) {
        const conversationId = row.key.slice(RECORD_PREFIX.length);
        if (!conversationId) continue;
        const parsed = parseRecordJson(row.value);
        if (!parsed) {
          log.warn('HandoffPersistenceService: skipping invalid handoff record in kv', {
            key: row.key,
          });
          continue;
        }
        records.push([conversationId, parsed]);
      } else if (row.key.startsWith(SUPERSEDED_PREFIX)) {
        const oldId = row.key.slice(SUPERSEDED_PREFIX.length);
        const newId = row.value;
        if (oldId && newId && oldId !== newId) {
          superseded.push([oldId, newId]);
        }
      }
    }

    return { records, superseded };
  }

  async put(conversationId: string, record: HandoffRecord): Promise<void> {
    if (!conversationId) return;
    const validated = handoffRecordSchema.parse(record);
    this.upsertKv(this.db, recordKey(conversationId), JSON.stringify(validated));
  }

  async remove(conversationId: string): Promise<void> {
    if (!conversationId) return;
    this.db
      .delete(kv)
      .where(eq(kv.key, recordKey(conversationId)))
      .run();
  }

  async markContextDelivered(conversationId: string): Promise<void> {
    if (!conversationId) return;
    const key = recordKey(conversationId);
    this.db.transaction((tx) => {
      const row = tx.select({ value: kv.value }).from(kv).where(eq(kv.key, key)).get();
      if (!row) return;
      const existing = parseRecordJson(row.value);
      if (!existing || existing.contextDelivered) return;
      this.upsertKv(tx, key, JSON.stringify({ ...existing, contextDelivered: true }));
    });
  }

  async clearTargetEffort(conversationId: string): Promise<void> {
    if (!conversationId) return;
    const key = recordKey(conversationId);
    this.db.transaction((tx) => {
      const row = tx.select({ value: kv.value }).from(kv).where(eq(kv.key, key)).get();
      if (!row) return;
      const existing = parseRecordJson(row.value);
      if (!existing || existing.targetEffort === undefined) return;
      const { targetEffort: _removed, ...rest } = existing;
      this.upsertKv(tx, key, JSON.stringify(rest));
    });
  }

  async markSuperseded(oldConversationId: string, newConversationId: string): Promise<void> {
    if (!oldConversationId || !newConversationId || oldConversationId === newConversationId) return;
    this.upsertKv(this.db, supersededKey(oldConversationId), newConversationId);
  }

  async bulkImport(input: HandoffBulkImportInput): Promise<void> {
    const parsed = handoffBulkImportInputSchema.safeParse(input);
    if (!parsed.success) {
      log.warn('HandoffPersistenceService: invalid bulkImport payload', {
        issues: parsed.error.issues,
      });
      return;
    }

    this.db.transaction((tx) => {
      for (const [conversationId, incoming] of parsed.data.records) {
        const key = recordKey(conversationId);
        const existingRow = tx.select({ value: kv.value }).from(kv).where(eq(kv.key, key)).get();
        if (!existingRow) {
          this.upsertKv(tx, key, JSON.stringify(incoming));
          continue;
        }
        const existingRecord = parseRecordJson(existingRow.value);
        if (!existingRecord || incoming.createdAt > existingRecord.createdAt) {
          this.upsertKv(tx, key, JSON.stringify(incoming));
        }
      }

      const now = unixNowSeconds();
      for (const [oldId, newId] of parsed.data.superseded) {
        if (!oldId || !newId || oldId === newId) continue;
        tx.insert(kv)
          .values({ key: supersededKey(oldId), value: newId, updatedAt: now })
          .onConflictDoNothing({ target: kv.key })
          .run();
      }
    });
  }

  private upsertKv(target: AppDb | DrizzleTx, key: string, value: string): void {
    const now = unixNowSeconds();
    (target as AppDb)
      .insert(kv)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({
        target: kv.key,
        set: { value, updatedAt: now },
      })
      .run();
  }
}
