import { describe, expect, it, vi } from 'vitest';
import { HandoffStore, type HandoffPersistenceBackend, type HandoffRecord } from './handoff-store';

function memoryStorage(initial?: string) {
  let value: string | null = initial ?? null;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
    read: () => value,
  };
}

function createFakeBackend(
  initial: {
    records?: Array<[string, HandoffRecord]>;
    superseded?: Array<[string, string]>;
  } = {}
): HandoffPersistenceBackend & {
  recordsMap: Map<string, HandoffRecord>;
  supersededMap: Map<string, string>;
} {
  const recordsMap = new Map<string, HandoffRecord>(initial.records ?? []);
  const supersededMap = new Map<string, string>(initial.superseded ?? []);

  return {
    recordsMap,
    supersededMap,
    listAll: vi.fn(async () => ({
      records: [...recordsMap.entries()],
      superseded: [...supersededMap.entries()],
    })),
    put: vi.fn(async (id, rec) => {
      recordsMap.set(id, rec);
    }),
    remove: vi.fn(async (id) => {
      recordsMap.delete(id);
    }),
    markContextDelivered: vi.fn(async (id) => {
      const existing = recordsMap.get(id);
      if (existing) recordsMap.set(id, { ...existing, contextDelivered: true });
    }),
    clearTargetEffort: vi.fn(async (id) => {
      const existing = recordsMap.get(id);
      if (existing) {
        const { targetEffort: _removed, ...rest } = existing;
        recordsMap.set(id, rest);
      }
    }),
    markSuperseded: vi.fn(async (oldId, newId) => {
      supersededMap.set(oldId, newId);
    }),
    bulkImport: vi.fn(async (input) => {
      for (const [id, incoming] of input.records) {
        const existing = recordsMap.get(id);
        if (!existing || incoming.createdAt > existing.createdAt) {
          recordsMap.set(id, incoming);
        }
      }
      for (const [oldId, newId] of input.superseded) {
        if (!supersededMap.has(oldId)) supersededMap.set(oldId, newId);
      }
    }),
  };
}

const record = (over: Partial<HandoffRecord> = {}): HandoffRecord => ({
  version: 1,
  mode: 'fork',
  sourceConversationId: 'src',
  sourceTitle: 'Kaynak',
  context: 'özet',
  createdAt: 1,
  ...over,
});

describe('HandoffStore', () => {
  it('kaydı saklar ve yeni örnekte geri yükler', () => {
    const storage = memoryStorage();
    new HandoffStore(storage).put('c1', record());
    expect(new HandoffStore(storage).get('c1')).toEqual(record());
  });

  it('bozuk ya da geçersiz depolama içeriğini yok sayar', () => {
    expect(new HandoffStore(memoryStorage('{bozuk')).get('x')).toBeUndefined();
    const invalid = JSON.stringify([
      ['c1', { version: 2 }],
      ['c2', record({ mode: 'fork' })],
    ]);
    const store = new HandoffStore(memoryStorage(invalid));
    expect(store.get('c1')).toBeUndefined();
    expect(store.get('c2')).toBeDefined();
  });

  it('depolama yokken bellek içi çalışır', () => {
    const store = new HandoffStore(null);
    store.put('c1', record());
    expect(store.get('c1')?.context).toBe('özet');
  });

  it('yazma hatası fırlatmaz', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('dolu');
      },
    };
    const store = new HandoffStore(storage);
    expect(() => store.put('c1', record())).not.toThrow();
    expect(store.get('c1')).toBeDefined();
  });

  it('bellek içi ve SQLite arka ucunda sınırsız kayıt tutarken localStorage yedeğini sınırlar', () => {
    const storage = memoryStorage();
    const supersededStorage = memoryStorage();
    const backend = createFakeBackend();
    const store = new HandoffStore(storage, supersededStorage);
    store.attachPersistence(backend);

    for (let i = 0; i < 205; i += 1) store.put(`c${i}`, record({ createdAt: i + 1 }));
    for (let i = 0; i < 405; i += 1) store.markSuperseded(`old-${i}`, `new-${i}`);

    // Bellek içi ve backend hiçbir kaydı silmez
    expect(store.get('c0')).toBeDefined();
    expect(store.get('c204')).toBeDefined();
    expect(store.isSuperseded('old-0')).toBe(true);
    expect(store.isSuperseded('old-404')).toBe(true);
    expect(backend.recordsMap.size).toBe(205);
    expect(backend.supersededMap.size).toBe(405);

    // localStorage fallback yalnızca en yeni 200 / 400 kaydı yazar
    const savedRecords = JSON.parse(storage.read() ?? '[]') as Array<[string, HandoffRecord]>;
    const savedSuperseded = JSON.parse(supersededStorage.read() ?? '[]') as Array<[string, string]>;
    expect(savedRecords).toHaveLength(200);
    expect(savedRecords[0]?.[0]).toBe('c5');
    expect(savedRecords[199]?.[0]).toBe('c204');
    expect(savedSuperseded).toHaveLength(400);
    expect(savedSuperseded[0]?.[0]).toBe('old-5');
    expect(savedSuperseded[399]?.[0]).toBe('old-404');
  });

  it('abonelere değişiklik bildirir ve silmeyi yansıtır', () => {
    const store = new HandoffStore(null);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.put('c1', record());
    store.remove('c1');
    store.remove('c1');
    off();
    store.put('c2', record());
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get('c1')).toBeUndefined();
  });

  it('contextDelivered alanını işaretler, korur ve depolamaya yazar', () => {
    const storage = memoryStorage();
    const store = new HandoffStore(storage);
    store.put(
      'c1',
      record({
        mode: 'inline-handoff',
        contextDelivered: false,
        chain: [
          {
            conversationId: 'src',
            fromProviderId: 'codex',
            fromModelLabel: 'GPT-6.2',
            toProviderId: 'antigravity',
            toModelLabel: 'Neon',
            createdAt: 10,
          },
        ],
      })
    );

    store.markContextDelivered('c1');
    const reloaded = new HandoffStore(storage).get('c1');
    expect(reloaded?.contextDelivered).toBe(true);
    expect(reloaded?.context).toBe('özet');
    expect(reloaded?.chain).toHaveLength(1);
  });

  it('backend ile tek seferlik hidrasyon yapar, localStorage kayıtlarını bulkImport ile aktarır ve SQLite önceliğini korur', async () => {
    const storage = memoryStorage(
      JSON.stringify([
        ['local-only', record({ context: 'yerel-tek', createdAt: 100 })],
        ['conflict', record({ context: 'yerel-eski', createdAt: 200 })],
        ['local-newer', record({ context: 'yerel-yeni', createdAt: 900 })],
      ])
    );
    const supersededStorage = memoryStorage(JSON.stringify([['old-local', 'new-local']]));
    const backend = createFakeBackend({
      records: [
        ['db-only', record({ context: 'veritabani-tek', createdAt: 300 })],
        [
          'conflict',
          record({ context: 'veritabani-guncel', createdAt: 200, contextDelivered: true }),
        ],
        ['local-newer', record({ context: 'veritabani-eski', createdAt: 400 })],
      ],
      superseded: [['old-db', 'new-db']],
    });

    const store = new HandoffStore(storage, supersededStorage);
    const listener = vi.fn();
    store.subscribe(listener);
    store.attachPersistence(backend);

    await Promise.all([store.hydrateFromBackend(), store.hydrateFromBackend()]);
    await store.hydrateFromBackend();

    expect(backend.listAll).toHaveBeenCalledTimes(1);
    expect(backend.bulkImport).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(store.get('local-only')?.context).toBe('yerel-tek');
    expect(store.get('db-only')?.context).toBe('veritabani-tek');
    expect(store.get('conflict')?.context).toBe('veritabani-guncel');
    expect(store.get('conflict')?.contextDelivered).toBe(true);
    expect(store.get('local-newer')?.context).toBe('yerel-yeni');

    expect(backend.recordsMap.get('local-only')?.context).toBe('yerel-tek');
    expect(backend.recordsMap.get('local-newer')?.context).toBe('yerel-yeni');
    expect(backend.supersededMap.get('old-local')).toBe('new-local');
    expect(store.resolveLatest('old-db')).toBe('new-db');
    expect(store.resolveLatest('old-local')).toBe('new-local');

    // localStorage silinmez, birleşen kayıtlarla güncel kalır
    expect(storage.read()).toContain('db-only');
    expect(storage.read()).toContain('local-only');
  });

  it('değişiklik yoksa hidrasyon sırasında gereksiz emit veya bulkImport yapmaz', async () => {
    const rec = record({ createdAt: 10 });
    const storage = memoryStorage(JSON.stringify([['c1', rec]]));
    const backend = createFakeBackend({ records: [['c1', rec]] });
    const store = new HandoffStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);
    store.attachPersistence(backend);

    await store.hydrateFromBackend();
    expect(backend.bulkImport).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('mutasyonları arka uca asenkron iletir ve arka uç hatalarını yutarak çökmez', async () => {
    const failingBackend = createFakeBackend();
    vi.mocked(failingBackend.put).mockRejectedValueOnce(new Error('sqlite busy'));
    vi.mocked(failingBackend.clearTargetEffort).mockRejectedValueOnce(new Error('fail'));
    vi.mocked(failingBackend.markContextDelivered).mockRejectedValueOnce(new Error('fail'));
    vi.mocked(failingBackend.markSuperseded).mockRejectedValueOnce(new Error('fail'));
    vi.mocked(failingBackend.remove).mockRejectedValueOnce(new Error('fail'));

    const store = new HandoffStore(null);
    store.attachPersistence(failingBackend);

    store.put('c1', record({ targetEffort: 'high', contextDelivered: false }));
    store.clearTargetEffort('c1');
    store.markContextDelivered('c1');
    store.markSuperseded('c0', 'c1');
    store.remove('c1');

    await Promise.resolve();
    expect(failingBackend.put).toHaveBeenCalledTimes(1);
    expect(failingBackend.clearTargetEffort).toHaveBeenCalledWith('c1');
    expect(failingBackend.markContextDelivered).toHaveBeenCalledWith('c1');
    expect(failingBackend.markSuperseded).toHaveBeenCalledWith('c0', 'c1');
    expect(failingBackend.remove).toHaveBeenCalledWith('c1');
  });

  it('getProvidersForConversationChain zincirdeki sağlayıcıları sırayla ve tekilleştirerek döndürür', () => {
    const store = new HandoffStore(null);
    store.put(
      'c-chain',
      record({
        mode: 'inline-handoff',
        chain: [
          {
            conversationId: 'c1',
            fromProviderId: 'codex',
            fromModelLabel: 'GPT-6.2',
            toProviderId: 'claude',
            toModelLabel: 'Opus',
            createdAt: 10,
          },
          {
            conversationId: 'c2',
            fromProviderId: 'claude',
            fromModelLabel: 'Opus',
            toProviderId: 'antigravity',
            toModelLabel: 'Neon',
            createdAt: 20,
          },
          {
            conversationId: 'c3',
            fromProviderId: 'antigravity',
            fromModelLabel: 'Neon',
            toProviderId: 'codex',
            toModelLabel: 'GPT-6.2',
            createdAt: 30,
          },
        ],
      })
    );

    expect(store.getProvidersForConversationChain('c-chain')).toEqual([
      'codex',
      'claude',
      'antigravity',
    ]);
    expect(store.getProvidersForConversationChain('missing')).toEqual([]);
  });
});

describe('HandoffStore context hand-over lineage', () => {
  const record = (source: string, createdAt: number): HandoffRecord => ({
    version: 1,
    mode: 'context-handoff',
    sourceConversationId: source,
    sourceTitle: 'Kaynak',
    context: '',
    contextDelivered: true,
    createdAt,
    contextSource: 'agent-brief',
    transcriptPath: '/home/u/.orkestra/handoffs/x.md',
    targetTaskId: 'task-next',
  });

  it('finds the newest context successor of a source and ignores other modes', () => {
    const store = new HandoffStore(null);
    store.put('fork-child', { ...record('src', 5), mode: 'fork' });
    expect(store.findContextSuccessor('src')).toBeUndefined();
    store.put('first', record('src', 10));
    store.put('second', record('src', 20));
    store.put('other', record('elsewhere', 30));
    expect(store.findContextSuccessor('src')).toBe('second');
  });

  it('round-trips the new fields through local storage', () => {
    const storage = memoryStorage();
    new HandoffStore(storage).put('n', record('src', 1));
    const reloaded = new HandoffStore(memoryStorage(storage.read() ?? undefined));
    expect(reloaded.get('n')).toMatchObject({
      mode: 'context-handoff',
      contextSource: 'agent-brief',
      transcriptPath: '/home/u/.orkestra/handoffs/x.md',
      targetTaskId: 'task-next',
    });
    expect(reloaded.findContextSuccessor('src')).toBe('n');
  });
});
