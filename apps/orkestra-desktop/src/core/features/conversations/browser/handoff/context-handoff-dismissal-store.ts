import { log } from '@orkestra/shared/logger';
import type { ContextHandoffDismissal } from '@core/features/conversations/api/context-handoff-policy';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const STORAGE_KEY = 'orkestra:context-handoff-dismissals:v1';
const MAX_CONVERSATIONS = 200;
const VALID: readonly ContextHandoffDismissal[] = ['warn', 'critical', 'moved'];
const EMPTY: readonly ContextHandoffDismissal[] = [];

type Listener = () => void;

/**
 * Bağlam devri şeritlerinin "Şimdi değil" kayıtları: sohbet kimliği → kapatılan adımlar. Renderer
 * yerel depolamasında tutulur (DB şeması yok). Okunamazsa bellek içi çalışır; en kötü sonuç
 * kapatılmış şeridin uygulama yeniden açılınca bir kez daha görünmesidir.
 */
export class ContextHandoffDismissalStore {
  private records = new Map<string, readonly ContextHandoffDismissal[]>();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly storage: StorageLike | null) {
    this.load();
  }

  get(conversationId: string): readonly ContextHandoffDismissal[] {
    return this.records.get(conversationId) ?? EMPTY;
  }

  add(conversationId: string, step: ContextHandoffDismissal): void {
    const current = this.get(conversationId);
    if (current.includes(step)) return;
    this.set(conversationId, [...current, step]);
  }

  /** Listeyi değiştirir; aynıysa hiçbir şey yazmaz. Boş liste kaydı siler. */
  set(conversationId: string, next: readonly ContextHandoffDismissal[]): void {
    const current = this.get(conversationId);
    if (current.length === next.length && current.every((entry, i) => entry === next[i])) return;
    this.records.delete(conversationId);
    if (next.length > 0) this.records.set(conversationId, [...next]);
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
        const valid = list.filter((step): step is ContextHandoffDismissal =>
          VALID.includes(step as ContextHandoffDismissal)
        );
        if (valid.length > 0) this.records.set(id, valid);
      }
    } catch (error) {
      log.warn('Failed to read context handoff dismissals', { error });
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify([...this.records.entries()]));
    } catch (error) {
      log.warn('Failed to persist context handoff dismissals', { error });
    }
  }
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let shared: ContextHandoffDismissalStore | null = null;

/** Uygulama genelindeki bağlam devri şeridi kapatma kayıtları. */
export function getContextHandoffDismissalStore(): ContextHandoffDismissalStore {
  shared ??= new ContextHandoffDismissalStore(browserStorage());
  return shared;
}
