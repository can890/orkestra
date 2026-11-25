import { randomBytes } from 'node:crypto';

/** 32 rastgele bayt, base64url: tahmin edilemez ve adres yolunda güvenle taşınır. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type MediaTokenRegistryOptions = {
  /** Son kullanımdan sonra belirtecin geçerli kaldığı süre. */
  idleTtlMs?: number;
  /** Aynı anda tutulan en fazla belirteç; aşılınca en eski kullanılan düşer. */
  maxEntries?: number;
  now?: () => number;
  createToken?: () => string;
};

type Entry<T> = { target: T; lastUsedAt: number };

/**
 * Belirteç → hedef eşlemesi. Belirteçler yalnızca ana süreçte, güvenilir renderer'ın Wire
 * isteğiyle üretilir; adres tek başına hiçbir dosya yolu taşımaz.
 */
export class MediaTokenRegistry<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly idleTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly createToken: () => string;

  constructor(options: MediaTokenRegistryOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? 6 * 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 512;
    this.now = options.now ?? Date.now;
    this.createToken = options.createToken ?? (() => randomBytes(32).toString('base64url'));
  }

  get size(): number {
    return this.entries.size;
  }

  mint(target: T): string {
    this.sweep();
    while (this.entries.size >= this.maxEntries) {
      // Map ekleme sırasını korur; resolve() dokunulan girdiyi sona taşır (LRU).
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const token = this.createToken();
    this.entries.set(token, { target, lastUsedAt: this.now() });
    return token;
  }

  resolve(token: string): T | undefined {
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    const now = this.now();
    if (now - entry.lastUsedAt > this.idleTtlMs) {
      this.entries.delete(token);
      return undefined;
    }
    entry.lastUsedAt = now;
    this.entries.delete(token);
    this.entries.set(token, entry);
    return entry.target;
  }

  release(token: string): void {
    this.entries.delete(token);
  }

  clear(): void {
    this.entries.clear();
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (now - entry.lastUsedAt > this.idleTtlMs) this.entries.delete(token);
    }
  }
}
