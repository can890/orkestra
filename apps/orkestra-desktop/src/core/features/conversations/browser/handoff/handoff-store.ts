import { log } from '@orkestra/shared/logger';

export type HandoffMode = 'fork' | 'handoff';

/** Çatallanan/devredilen bir sohbetin soy bilgisi ve (henüz gönderilmemiş) devir bağlamı. */
export type HandoffRecord = {
  version: 1;
  mode: HandoffMode;
  sourceConversationId: string;
  sourceTitle: string;
  /** Çatallamanın kesildiği mesaj kimliği; sohbetin tamamı alındıysa yok. */
  sourceItemId?: string;
  /** Yeni sohbetin ilk istemiyle birlikte gidecek özet. Sohbet boş olduğu sürece eklenir. */
  context: string;
  createdAt: number;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const STORAGE_KEY = 'orkestra:conversation-handoffs:v1';
const MAX_RECORDS = 200;

type Listener = () => void;

/**
 * Soy bilgisini ve bekleyen devir bağlamını renderer yerel depolamasında tutar (DB şeması
 * eklemeden). Depolama okunamazsa bellek içi çalışır; özellik yalnızca yeniden başlatmada
 * bağlamı kaybeder.
 */
export class HandoffStore {
  private records = new Map<string, HandoffRecord>();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly storage: StorageLike | null) {
    this.load();
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

  remove(conversationId: string): void {
    if (!this.records.delete(conversationId)) return;
    this.persist();
    this.emit();
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
}

function isHandoffRecord(value: unknown): value is HandoffRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    (record.mode === 'fork' || record.mode === 'handoff') &&
    typeof record.sourceConversationId === 'string' &&
    typeof record.sourceTitle === 'string' &&
    typeof record.context === 'string' &&
    typeof record.createdAt === 'number' &&
    (record.sourceItemId === undefined || typeof record.sourceItemId === 'string')
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
  shared ??= new HandoffStore(browserStorage());
  return shared;
}
