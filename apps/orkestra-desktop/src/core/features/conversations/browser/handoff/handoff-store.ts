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

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const STORAGE_KEY = 'orkestra:conversation-handoffs:v1';
const SUPERSEDED_STORAGE_KEY = 'orkestra:conversation-superseded:v1';
const MAX_RECORDS = 200;
const MAX_SUPERSEDED = 400;

type Listener = () => void;

/**
 * Soy bilgisini ve bekleyen devir bağlamını renderer yerel depolamasında tutar (DB şeması
 * eklemeden). Depolama okunamazsa bellek içi çalışır; özellik yalnızca yeniden başlatmada
 * bağlamı kaybeder.
 */
export class HandoffStore {
  private records = new Map<string, HandoffRecord>();
  private superseded = new Map<string, string>();
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly storage: StorageLike | null,
    private readonly supersededStorage: StorageLike | null = null
  ) {
    this.load();
    this.loadSuperseded();
  }

  get(conversationId: string): HandoffRecord | undefined {
    return this.records.get(conversationId);
  }

  put(conversationId: string, record: HandoffRecord): void {
    this.records.delete(conversationId);
    this.records.set(conversationId, record);
    while (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
    this.persist();
    this.emit();
  }

  clearTargetEffort(conversationId: string): void {
    const existing = this.records.get(conversationId);
    if (!existing || existing.targetEffort === undefined) return;
    const { targetEffort: _removed, ...rest } = existing;
    this.records.set(conversationId, rest);
    this.persist();
  }

  markContextDelivered(conversationId: string): void {
    const existing = this.records.get(conversationId);
    if (!existing || existing.contextDelivered) return;
    this.records.set(conversationId, { ...existing, contextDelivered: true });
    this.persist();
    this.emit();
  }

  remove(conversationId: string): void {
    if (!this.records.delete(conversationId)) return;
    this.persist();
    this.emit();
  }

  markSuperseded(oldConversationId: string, newConversationId: string): void {
    if (!oldConversationId || !newConversationId || oldConversationId === newConversationId) return;
    this.superseded.delete(oldConversationId);
    this.superseded.set(oldConversationId, newConversationId);
    while (this.superseded.size > MAX_SUPERSEDED) {
      const oldest = this.superseded.keys().next().value;
      if (oldest === undefined) break;
      this.superseded.delete(oldest);
    }
    this.persistSuperseded();
    this.emit();
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
      this.storage.setItem(STORAGE_KEY, JSON.stringify([...this.records.entries()]));
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
      this.supersededStorage.setItem(
        SUPERSEDED_STORAGE_KEY,
        JSON.stringify([...this.superseded.entries()])
      );
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
