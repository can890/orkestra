import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '@core/services/app-db/node/db';
import { kv } from '@core/services/app-db/node/schema';
import {
  handoffBulkImportInputSchema,
  handoffListAllOutputSchema,
  HandoffPersistenceService,
  type HandoffRecord,
} from './handoff-persistence';

function makeRecord(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    version: 1,
    mode: 'fork',
    sourceConversationId: 'conv-src',
    sourceTitle: 'Kaynak Sohbet',
    context: 'Özet metni',
    createdAt: 1000,
    ...overrides,
  };
}

describe('HandoffPersistenceService', () => {
  let sqlite: Database.Database;
  let db: AppDb;
  let service: HandoffPersistenceService;

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
    service = new HandoffPersistenceService(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('stores, reads, and removes handoff records and superseded mappings', async () => {
    const rec1 = makeRecord({
      mode: 'inline-handoff',
      contextDelivered: false,
      targetEffort: 'high',
      chain: [
        {
          conversationId: 'conv-src',
          fromProviderId: 'codex',
          fromModelLabel: 'GPT-6.2',
          toProviderId: 'claude',
          toModelLabel: 'Opus 4.5',
          createdAt: 900,
        },
      ],
    });
    const rec2 = makeRecord({
      sourceConversationId: 'conv-2',
      sourceItemId: 'item-5',
      createdAt: 2000,
    });

    await service.put('conv-1', rec1);
    await service.put('conv-2', rec2);
    await service.markSuperseded('conv-src', 'conv-1');

    const listed = await service.listAll();
    expect(handoffListAllOutputSchema.safeParse(listed).success).toBe(true);
    expect(new Map(listed.records).get('conv-1')).toEqual(rec1);
    expect(new Map(listed.records).get('conv-2')).toEqual(rec2);
    expect(listed.superseded).toEqual([['conv-src', 'conv-1']]);

    await service.remove('conv-2');
    const afterRemove = await service.listAll();
    expect(new Map(afterRemove.records).has('conv-2')).toBe(false);
    expect(new Map(afterRemove.records).has('conv-1')).toBe(true);
  });

  it('updates contextDelivered and clears targetEffort cleanly', async () => {
    await service.put(
      'conv-1',
      makeRecord({
        contextDelivered: false,
        targetEffort: 'medium',
      })
    );

    await service.markContextDelivered('conv-1');
    await service.clearTargetEffort('conv-1');

    const listed = await service.listAll();
    const saved = new Map(listed.records).get('conv-1');
    expect(saved?.contextDelivered).toBe(true);
    expect(saved?.targetEffort).toBeUndefined();
    expect('targetEffort' in (saved ?? {})).toBe(false);

    // No-op for missing records
    await expect(service.markContextDelivered('missing')).resolves.toBeUndefined();
    await expect(service.clearTargetEffort('missing')).resolves.toBeUndefined();
  });

  it('ignores non-handoff kv rows and corrupt handoff json entries on listAll', async () => {
    sqlite
      .prepare(`INSERT INTO kv (key, value) VALUES (?, ?), (?, ?), (?, ?)`)
      .run(
        'fts_version',
        '5',
        'handoff:record:corrupt',
        '{not-json',
        'handoff:record:invalid-schema',
        JSON.stringify({ version: 2 })
      );
    await service.put('valid-1', makeRecord());

    const listed = await service.listAll();
    expect(listed.records).toEqual([['valid-1', makeRecord()]]);
    expect(listed.superseded).toEqual([]);
  });

  it('bulkImport is strictly additive and only overwrites when incoming createdAt is strictly newer', async () => {
    const existingSameAge = makeRecord({ context: 'mevcut-esit', createdAt: 1000 });
    const existingNewer = makeRecord({ context: 'mevcut-yeni', createdAt: 3000 });
    const existingOlder = makeRecord({ context: 'mevcut-eski', createdAt: 500 });

    await service.put('c-same', existingSameAge);
    await service.put('c-newer', existingNewer);
    await service.put('c-older', existingOlder);
    await service.put('c-untouched', makeRecord({ context: 'korunan', createdAt: 4000 }));
    await service.markSuperseded('old-a', 'existing-target');

    const payload = {
      records: [
        ['c-same', makeRecord({ context: 'gelen-esit', createdAt: 1000 })] as [
          string,
          HandoffRecord,
        ],
        ['c-newer', makeRecord({ context: 'gelen-eski', createdAt: 2000 })] as [
          string,
          HandoffRecord,
        ],
        ['c-older', makeRecord({ context: 'gelen-yeni', createdAt: 1500 })] as [
          string,
          HandoffRecord,
        ],
        ['c-missing', makeRecord({ context: 'yeni-eklenen', createdAt: 100 })] as [
          string,
          HandoffRecord,
        ],
      ],
      superseded: [
        ['old-a', 'overwrite-attempt'] as [string, string],
        ['old-b', 'new-target'] as [string, string],
      ],
    };

    expect(handoffBulkImportInputSchema.safeParse(payload).success).toBe(true);
    await service.bulkImport(payload);

    const listed = await service.listAll();
    const recordMap = new Map(listed.records);
    const supersededMap = new Map(listed.superseded);

    expect(recordMap.get('c-same')?.context).toBe('mevcut-esit');
    expect(recordMap.get('c-newer')?.context).toBe('mevcut-yeni');
    expect(recordMap.get('c-older')?.context).toBe('gelen-yeni');
    expect(recordMap.get('c-missing')?.context).toBe('yeni-eklenen');
    expect(recordMap.get('c-untouched')?.context).toBe('korunan');

    expect(supersededMap.get('old-a')).toBe('existing-target');
    expect(supersededMap.get('old-b')).toBe('new-target');
  });

  it('retains more than 200 records and 400 superseded entries without eviction', async () => {
    const records: Array<[string, HandoffRecord]> = [];
    const superseded: Array<[string, string]> = [];
    for (let i = 0; i < 250; i += 1) {
      records.push([`c-${i}`, makeRecord({ createdAt: i + 1 })]);
    }
    for (let i = 0; i < 450; i += 1) {
      superseded.push([`old-${i}`, `new-${i}`]);
    }

    await service.bulkImport({ records, superseded });
    const listed = await service.listAll();
    expect(listed.records).toHaveLength(250);
    expect(listed.superseded).toHaveLength(450);
  });
});
