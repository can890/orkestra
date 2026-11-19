import { log } from '@orkestra/shared/logger';
import type { LimitDismissal } from './handoff-suggestions';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const STORAGE_KEY = 'orkestra:handoff-limit-dismissals:v1';
const MAX_CONVERSATIONS = 200;

type Listener = () => void;

/**
 * Kapatılan limit şeritlerinin kaydı: sohbet kimliği → süresi dolmamış kapatmalar. Renderer yerel
 * depolamasında tutulur (DB şeması yok); okunamazsa bellek içi çalışır, en kötü sonuç kapatılmış
 * şeridin yeniden görünmesidir.
 */
export class LimitDismissalStore {
  private records = new Map<string, LimitDismissal[]>();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly storage: StorageLike | null) {
    this.load();
  }

  get(conversationId: string): readonly LimitDismissal[] {
    return this.records.get(conversationId) ?? EMPTY;
  }

  /** Aynı anahtarın eski kaydını yenisiyle değiştirir; süresi dolanları atar. */
  add(conversationId: string, dismissals: readonly LimitDismissal[], now: number): void {
    if (dismissals.length === 0) return;
    const keys = new Set(dismissals.map((dismissal) => dismissal.key));
    const kept = (this.records.get(conversationId) ?? []).filter(
      (existing) => existing.expiresAt > now && !keys.has(existing.key)
    );
    this.records.delete(conversationId);
    this.records.set(conversationId, [...kept, ...dismissals]);
    while (this.records.size > MAX_CONVERSATIONS) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
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
        const [id, list] = entry as [unknown, unknown];
        if (typeof id !== 'string' || !Array.isArray(list)) continue;
        const valid = list.filter(isDismissal);
        if (valid.length > 0) this.records.set(id, valid);
      }
    } catch (error) {
      log.warn('Failed to read handoff limit dismissals', { error });
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify([...this.records.entries()]));
    } catch (error) {
      log.warn('Failed to persist handoff limit dismissals', { error });
    }
  }
}

const EMPTY: readonly LimitDismissal[] = [];

function isDismissal(value: unknown): value is LimitDismissal {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.key === 'string' && typeof record.expiresAt === 'number';
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let shared: LimitDismissalStore | null = null;

/** Uygulama genelindeki limit şeridi kapatma kayıtları. */
export function getLimitDismissalStore(): LimitDismissalStore {
  shared ??= new LimitDismissalStore(browserStorage());
  return shared;
}
