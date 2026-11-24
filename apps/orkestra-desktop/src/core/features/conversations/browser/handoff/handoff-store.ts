import type { PrefixTranscriptTurn } from '@orkestra/chat-ui';
import { log } from '@orkestra/shared/logger';

export type HandoffMode = 'fork' | 'handoff' | 'inline-handoff';

export type HandoffChainSegment = {
  conversationId: string;
  fromProviderId: string;
  fromModelLabel: string;
  toProviderId: string;
  toModelLabel: string;
  createdAt: number;
};

/** Çatallanan/devredilen bir sohbetin soy bilgisi ve (henüz gönderilmemiş) devir bağlamı. */
export type HandoffRecord = {
  version: 1;
  mode: HandoffMode;
  sourceConversationId: string;
  sourceTitle: string;
  /** Çatallamanın kesildiği mesaj kimliği; sohbetin tamamı alındıysa yok. */
  sourceItemId?: string;
  /** Yeni sohbetin ilk istemiyle birlikte gidecek özet. İlk başarılı gönderime kadar korunur. */
  context: string;
  /** Bağlam özeti hedef sohbete başarıyla iletildi mi. */
  contextDelivered?: boolean;
  createdAt: number;
  /** Aynı sohbette kesintisiz yapay zeka geçiş zinciri (kronolojik sırada). */
  chain?: HandoffChainSegment[];
  /** Hedef oturuma geçerken uygulanacak düşünme/efor seviyesi. */
  targetEffort?: string;
};

export interface HandoffPersistenceBackend {
  listAll(): Promise<{
    records: Array<[string, HandoffRecord]>;
    superseded: Array<[string, string]>;
  }>;
  put(conversationId: string, record: HandoffRecord): Promise<void>;
  remove(conversationId: string): Promise<void>;
  markContextDelivered(conversationId: string): Promise<void>;
  clearTargetEffort(conversationId: string): Promise<void>;
  markSuperseded(oldConversationId: string, newConversationId: string): Promise<void>;
  bulkImport(input: {
    records: Array<[string, HandoffRecord]>;
    superseded: Array<[string, string]>;
  }): Promise<void>;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const STORAGE_KEY = 'orkestra:conversation-handoffs:v1';
const SUPERSEDED_STORAGE_KEY = 'orkestra:conversation-superseded:v1';
const MAX_LOCAL_RECORDS = 200;
const MAX_LOCAL_SUPERSEDED = 400;

type Listener = () => void;

function recordsEqual(a: HandoffRecord, b: HandoffRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Soy bilgisini ve bekleyen devir bağlamını bellek içi tutar; bağlıysa kalıcı SQLite
 * arka ucuna (sınırsız) yazar ve tarayıcı `localStorage`'ı yedek önbellek olarak güncel tutar.
 */
export class HandoffStore {
  private records = new Map<string, HandoffRecord>();
  private superseded = new Map<string, string>();
  private readonly listeners = new Set<Listener>();
  private backend: HandoffPersistenceBackend | null = null;
  private hydratedBackend: HandoffPersistenceBackend | null = null;
  private hydrationPromise: Promise<void> | null = null;

  constructor(
    private readonly storage: StorageLike | null,
    private readonly supersededStorage: StorageLike | null = null
  ) {
    this.load();
    this.loadSuperseded();
  }

  attachPersistence(backend: HandoffPersistenceBackend): void {
    this.backend = backend;
    if (this.hydratedBackend !== backend) {
      this.hydrationPromise = null;
    }
  }

  hydrateFromBackend(): Promise<void> {
    const backend = this.backend;
    if (!backend) return Promise.resolve();
    if (this.hydrationPromise && this.hydratedBackend === backend) {
      return this.hydrationPromise;
    }
    this.hydratedBackend = backend;
    this.hydrationPromise = this.runHydration(backend).catch((error) => {
      log.warn('Failed to hydrate conversation handoffs from backend', { error });
      if (this.hydratedBackend === backend) {
        this.hydrationPromise = null;
        this.hydratedBackend = null;
      }
    });
    return this.hydrationPromise;
  }

  private async runHydration(backend: HandoffPersistenceBackend): Promise<void> {
    const { records: remoteRecords, superseded: remoteSuperseded } = await backend.listAll();
    const remoteRecordMap = new Map<string, HandoffRecord>();
    for (const [id, rec] of remoteRecords) {
      if (id && isHandoffRecord(rec)) remoteRecordMap.set(id, rec);
    }
    const remoteSupersededMap = new Map<string, string>();
    for (const [oldId, newId] of remoteSuperseded) {
      if (oldId && newId && oldId !== newId) remoteSupersededMap.set(oldId, newId);
    }

    const toImportRecords: Array<[string, HandoffRecord]> = [];
    const toImportSuperseded: Array<[string, string]> = [];
    let recordsUpdated = false;
    let supersededUpdated = false;

    for (const [id, local] of this.records.entries()) {
      const remote = remoteRecordMap.get(id);
      if (!remote || local.createdAt > remote.createdAt) {
        toImportRecords.push([id, local]);
      }
    }

    for (const [id, remote] of remoteRecordMap.entries()) {
      const local = this.records.get(id);
      if (!local) {
        this.records.set(id, remote);
        recordsUpdated = true;
      } else if (remote.createdAt >= local.createdAt && !recordsEqual(local, remote)) {
        this.records.set(id, remote);
        recordsUpdated = true;
      }
    }

    for (const [oldId, newId] of this.superseded.entries()) {
      if (!remoteSupersededMap.has(oldId)) {
        toImportSuperseded.push([oldId, newId]);
      }
    }

    for (const [oldId, newId] of remoteSupersededMap.entries()) {
      if (this.superseded.get(oldId) !== newId) {
        this.superseded.set(oldId, newId);
        supersededUpdated = true;
      }
    }

    if (toImportRecords.length > 0 || toImportSuperseded.length > 0) {
      await backend
        .bulkImport({ records: toImportRecords, superseded: toImportSuperseded })
        .catch((error) => {
          log.warn('Failed to bulk import handoff records to backend', { error });
        });
    }

    if (recordsUpdated) this.persist();
    if (supersededUpdated) this.persistSuperseded();
    if (recordsUpdated || supersededUpdated) this.emit();
  }

  get(conversationId: string): HandoffRecord | undefined {
    return this.records.get(conversationId);
  }

  getProvidersForConversationChain(conversationId: string): string[] {
    const record = this.records.get(conversationId);
    if (!record?.chain?.length) return [];
    const seen = new Set<string>();
    const providers: string[] = [];
    for (const segment of record.chain) {
      for (const providerId of [segment.fromProviderId, segment.toProviderId]) {
        if (!providerId || seen.has(providerId)) continue;
        seen.add(providerId);
        providers.push(providerId);
      }
    }
    return providers;
  }

  put(conversationId: string, record: HandoffRecord): void {
    this.records.delete(conversationId);
    this.records.set(conversationId, record);
    this.persist();
    this.emit();
    if (this.backend) {
      void this.backend.put(conversationId, record).catch((error) => {
        log.warn('Failed to persist handoff record to backend', { conversationId, error });
      });
    }
  }

  clearTargetEffort(conversationId: string): void {
    const existing = this.records.get(conversationId);
    if (!existing || existing.targetEffort === undefined) return;
    const { targetEffort: _removed, ...rest } = existing;
    this.records.set(conversationId, rest);
    this.persist();
    if (this.backend) {
      void this.backend.clearTargetEffort(conversationId).catch((error) => {
        log.warn('Failed to clear targetEffort in backend', { conversationId, error });
      });
    }
  }

  markContextDelivered(conversationId: string): void {
    const existing = this.records.get(conversationId);
    if (!existing || existing.contextDelivered) return;
    this.records.set(conversationId, { ...existing, contextDelivered: true });
    this.persist();
    this.emit();
    if (this.backend) {
      void this.backend.markContextDelivered(conversationId).catch((error) => {
        log.warn('Failed to mark contextDelivered in backend', { conversationId, error });
      });
    }
  }

  remove(conversationId: string): void {
    if (!this.records.delete(conversationId)) return;
    this.persist();
    this.emit();
    if (this.backend) {
      void this.backend.remove(conversationId).catch((error) => {
        log.warn('Failed to remove handoff record from backend', { conversationId, error });
      });
    }
  }

  markSuperseded(oldConversationId: string, newConversationId: string): void {
    if (!oldConversationId || !newConversationId || oldConversationId === newConversationId) return;
    this.superseded.delete(oldConversationId);
    this.superseded.set(oldConversationId, newConversationId);
    this.persistSuperseded();
    this.emit();
    if (this.backend) {
      void this.backend.markSuperseded(oldConversationId, newConversationId).catch((error) => {
        log.warn('Failed to persist superseded mapping to backend', {
          oldConversationId,
          newConversationId,
          error,
        });
      });
    }
  }

  isSuperseded(conversationId: string): boolean {
    return this.superseded.has(conversationId);
  }

  resolveLatest(conversationId: string): string {
    let current = conversationId;
    const seen = new Set<string>([current]);
    while (true) {
      const next = this.superseded.get(current);
      if (!next || seen.has(next)) return current;
      seen.add(next);
      current = next;
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [id, record] = entry as [unknown, unknown];
        if (typeof id === 'string' && isHandoffRecord(record)) this.records.set(id, record);
      }
    } catch (error) {
      log.warn('Failed to read conversation handoff records', { error });
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      const entries = [...this.records.entries()];
      const bounded =
        entries.length > MAX_LOCAL_RECORDS ? entries.slice(-MAX_LOCAL_RECORDS) : entries;
      this.storage.setItem(STORAGE_KEY, JSON.stringify(bounded));
    } catch (error) {
      log.warn('Failed to persist conversation handoff records', { error });
    }
  }

  private loadSuperseded(): void {
    if (!this.supersededStorage) return;
    try {
      const raw = this.supersededStorage.getItem(SUPERSEDED_STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [oldId, newId] = entry as [unknown, unknown];
        if (typeof oldId === 'string' && typeof newId === 'string' && oldId !== newId) {
          this.superseded.set(oldId, newId);
        }
      }
    } catch (error) {
      log.warn('Failed to read superseded conversations', { error });
    }
  }

  private persistSuperseded(): void {
    if (!this.supersededStorage) return;
    try {
      const entries = [...this.superseded.entries()];
      const bounded =
        entries.length > MAX_LOCAL_SUPERSEDED ? entries.slice(-MAX_LOCAL_SUPERSEDED) : entries;
      this.supersededStorage.setItem(SUPERSEDED_STORAGE_KEY, JSON.stringify(bounded));
    } catch (error) {
      log.warn('Failed to persist superseded conversations', { error });
    }
  }
}

function isChainSegment(value: unknown): value is HandoffChainSegment {
  if (!value || typeof value !== 'object') return false;
  const seg = value as Record<string, unknown>;
  return (
    typeof seg.conversationId === 'string' &&
    typeof seg.fromProviderId === 'string' &&
    typeof seg.fromModelLabel === 'string' &&
    typeof seg.toProviderId === 'string' &&
    typeof seg.toModelLabel === 'string' &&
    typeof seg.createdAt === 'number'
  );
}

function isHandoffRecord(value: unknown): value is HandoffRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    (record.mode === 'fork' || record.mode === 'handoff' || record.mode === 'inline-handoff') &&
    typeof record.sourceConversationId === 'string' &&
    typeof record.sourceTitle === 'string' &&
    typeof record.context === 'string' &&
    typeof record.createdAt === 'number' &&
    (record.contextDelivered === undefined || typeof record.contextDelivered === 'boolean') &&
    (record.sourceItemId === undefined || typeof record.sourceItemId === 'string') &&
    (record.targetEffort === undefined || typeof record.targetEffort === 'string') &&
    (record.chain === undefined ||
      (Array.isArray(record.chain) && record.chain.every(isChainSegment)))
  );
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let shared: HandoffStore | null = null;

/** Uygulama genelindeki devir kayıtları. */
export function getHandoffStore(): HandoffStore {
  const storage = browserStorage();
  shared ??= new HandoffStore(storage, storage);
  return shared;
}

// ── Bellek içi anlık ön-geçmiş ve taslak aktarımı ─────────────────────────────

const prefixTurnsCache = new Map<string, readonly PrefixTranscriptTurn[]>();
const pendingDraftTextCache = new Map<string, string>();

export function setCachedPrefixTurns(
  conversationId: string,
  turns: readonly PrefixTranscriptTurn[]
): void {
  prefixTurnsCache.set(conversationId, turns);
  while (prefixTurnsCache.size > 100) {
    const oldest = prefixTurnsCache.keys().next().value;
    if (oldest === undefined) break;
    prefixTurnsCache.delete(oldest);
  }
}

export function getCachedPrefixTurns(
  conversationId: string
): readonly PrefixTranscriptTurn[] | undefined {
  return prefixTurnsCache.get(conversationId);
}

export function setPendingDraftText(conversationId: string, text: string): void {
  if (!text) return;
  pendingDraftTextCache.set(conversationId, text);
}

export function consumePendingDraftText(conversationId: string): string | undefined {
  const text = pendingDraftTextCache.get(conversationId);
  if (text !== undefined) pendingDraftTextCache.delete(conversationId);
  return text;
}
