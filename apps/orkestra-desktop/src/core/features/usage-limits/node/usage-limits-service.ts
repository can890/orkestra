import { formatHostRef, type HostRef } from '@orkestra/core/primitives/host/api';
import type { AccountUsage } from '@orkestra/core/runtimes/agent-config/api';
import type {
  ProviderUsage,
  UsageLimitsReader,
} from '@core/features/usage-limits/api/usage-limits';

/** Bir makinedeki bir sağlayıcının kullanımını o makinenin ajan yapılandırma çalışma zamanından okur. */
export type UsageFetcher = (host: HostRef, providerId: string) => Promise<AccountUsage>;

export type UsageLimitsServiceOptions = {
  fetch: UsageFetcher;
  now?: () => number;
  /** Başarılı ölçümün önbellekte taze sayıldığı süre. */
  ttlMs?: number;
  /** Veri alınamayan sağlayıcının yeniden denenmeden önce beklenen süre. */
  errorTtlMs?: number;
};

const DEFAULT_TTL_MS = 3 * 60_000;
const DEFAULT_ERROR_TTL_MS = 60_000;

type Entry = {
  value: ProviderUsage | null;
  inflight: Promise<ProviderUsage> | null;
};

/**
 * Makine × sağlayıcı başına kullanım önbelleği. Aynı anahtar için eşzamanlı istekler tek sorguda
 * birleşir; yenileme başarısız olursa önceki geçerli pencereler korunur ve hata ayrıca bildirilir.
 * Zamanlayıcı yoktur: göstergenin periyodik sorgusu ve Orkestra'nın ihtiyacı yenilemeyi tetikler.
 */
export class UsageLimitsService implements UsageLimitsReader {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly errorTtlMs: number;

  constructor(private readonly options: UsageLimitsServiceOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.errorTtlMs = options.errorTtlMs ?? DEFAULT_ERROR_TTL_MS;
  }

  get(
    host: HostRef,
    providerIds: readonly string[],
    options: { force?: boolean } = {}
  ): Promise<ProviderUsage[]> {
    return Promise.all(
      [...new Set(providerIds)].map((id) => this.read(host, id, options.force === true))
    );
  }

  async peek(
    host: HostRef,
    providerIds: readonly string[],
    maxWaitMs: number
  ): Promise<Record<string, ProviderUsage | null>> {
    const ids = [...new Set(providerIds)];
    const timeout = Symbol('timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof timeout>((resolve) => {
      timer = setTimeout(() => resolve(timeout), Math.max(0, maxWaitMs));
    });
    try {
      const values = await Promise.all(
        ids.map(async (id) => {
          const pending = this.read(host, id, false);
          const result = await Promise.race([pending, deadline]);
          return [id, result === timeout ? this.cached(host, id) : result] as const;
        })
      );
      return Object.fromEntries(values);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Önbellekteki son değer; hiç okunmadıysa null. */
  cached(host: HostRef, providerId: string): ProviderUsage | null {
    return this.entries.get(keyOf(host, providerId))?.value ?? null;
  }

  private read(host: HostRef, providerId: string, force: boolean): Promise<ProviderUsage> {
    const key = keyOf(host, providerId);
    const entry = this.entries.get(key) ?? { value: null, inflight: null };
    this.entries.set(key, entry);
    if (entry.inflight) return entry.inflight;
    if (!force && entry.value && this.isFresh(entry.value)) return Promise.resolve(entry.value);
    const inflight = this.fetchOne(host, providerId, entry.value).then((value) => {
      entry.value = value;
      return value;
    });
    entry.inflight = inflight;
    void inflight.finally(() => {
      if (entry.inflight === inflight) entry.inflight = null;
    });
    return inflight;
  }

  private isFresh(value: ProviderUsage): boolean {
    const ttl = value.status === 'available' && !value.refreshError ? this.ttlMs : this.errorTtlMs;
    return this.now() - value.fetchedAt < ttl;
  }

  private async fetchOne(
    host: HostRef,
    providerId: string,
    previous: ProviderUsage | null
  ): Promise<ProviderUsage> {
    let usage: AccountUsage;
    try {
      usage = await this.options.fetch(host, providerId);
    } catch {
      usage = {
        providerId,
        status: 'error',
        checkedAt: new Date(this.now()).toISOString(),
        source: 'Orkestra',
        message: 'Makinenin ajan çalışma zamanına ulaşılamadı.',
        windows: [],
        balances: [],
      };
    }
    const next = toProviderUsage(usage, this.now());
    if (next.windows.length === 0 && next.status !== 'available' && previous?.windows.length) {
      return {
        ...previous,
        fetchedAt: next.fetchedAt,
        refreshError: next.message ?? 'Kullanım bilgisi yenilenemedi.',
      };
    }
    return next;
  }
}

/** Çalışma zamanının ölçümünü (kalan yüzde) göstergenin ve yönlendirmenin biçimine (kullanılan yüzde) çevirir. */
export function toProviderUsage(usage: AccountUsage, fetchedAt: number): ProviderUsage {
  return {
    providerId: usage.providerId,
    status: usage.status,
    windows: usage.windows.map((window) => ({
      label: window.label,
      usedPercent: clampPercent(100 - window.remainingPercent),
      ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
    })),
    balances: usage.balances,
    ...(usage.plan ? { plan: usage.plan } : {}),
    ...(usage.account ? { account: usage.account } : {}),
    source: usage.source,
    ...(usage.message ? { message: usage.message } : {}),
    measuredAt: usage.checkedAt,
    fetchedAt,
  };
}

function clampPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;
}

function keyOf(host: HostRef, providerId: string): string {
  return `${formatHostRef(host)}\u0000${providerId}`;
}
