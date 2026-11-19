export type AuthRateLimiterOptions = {
  /** Pencere içinde izin verilen başarısız el sıkışma sayısı. */
  maxFailures?: number;
  windowMs?: number;
  /** İlk kilit süresi; her tekrarda ikiye katlanır. */
  baseLockMs?: number;
  maxLockMs?: number;
  /** Bellekte tutulan en fazla anahtar sayısı (en eskisi atılır). */
  maxTrackedKeys?: number;
  now?: () => number;
};

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

type Entry = {
  failures: number[];
  strikes: number;
  lockedUntil: number;
  lastFailureAt: number;
};

/**
 * Başarısız el sıkışmalara hız sınırı. Anahtar bir adres (`ip:…`) ya da cihaz kimliği
 * (`device:…`) olabilir. Sınır aşılınca üstel artan süreyle kilitlenir.
 */
export class AuthRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly baseLockMs: number;
  private readonly maxLockMs: number;
  private readonly maxTrackedKeys: number;
  private readonly now: () => number;

  constructor(options: AuthRateLimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? 5;
    this.windowMs = options.windowMs ?? 60_000;
    this.baseLockMs = options.baseLockMs ?? 30_000;
    this.maxLockMs = options.maxLockMs ?? 15 * 60_000;
    this.maxTrackedKeys = options.maxTrackedKeys ?? 2048;
    this.now = options.now ?? Date.now;
  }

  check(key: string): RateLimitDecision {
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true };
    const now = this.now();
    if (now < entry.lockedUntil) return { allowed: false, retryAfterMs: entry.lockedUntil - now };
    return { allowed: true };
  }

  recordFailure(key: string): void {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { failures: [], strikes: 0, lockedUntil: 0, lastFailureAt: now };
      this.entries.set(key, entry);
      this.evict();
    }
    // Uzun süre sessiz kalan anahtarın geçmiş cezası unutulur.
    if (now - entry.lastFailureAt > this.maxLockMs * 2) entry.strikes = 0;
    entry.lastFailureAt = now;
    entry.failures = entry.failures.filter((at) => now - at < this.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.maxFailures) {
      entry.strikes += 1;
      entry.failures = [];
      const lock = Math.min(this.maxLockMs, this.baseLockMs * 2 ** (entry.strikes - 1));
      entry.lockedUntil = now + lock;
    }
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  private evict(): void {
    while (this.entries.size > this.maxTrackedKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}
