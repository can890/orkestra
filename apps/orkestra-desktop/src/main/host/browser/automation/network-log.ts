import type { BrowserNetworkRequest } from '@core/primitives/browser/api/agent-browser';

/**
 * Sekmenin ağ istekleri için DevTools (CDP) Network olaylarından beslenen halka arabellek.
 * Gövdeler tutulmaz; yalnızca özet ve (gizli başlıkları maskelenmiş) başlıklar saklanır.
 */

export const NETWORK_LOG_CAPACITY = 500;
const URL_MAX_CHARS = 4_000;
const HEADER_VALUE_MAX_CHARS = 2_000;
const MAX_HEADERS = 100;
export const REDACTED_HEADER_VALUE = '[redacted]';
const REDACTED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);

export type NetworkLogEntry = BrowserNetworkRequest & {
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
};

type InternalEntry = NetworkLogEntry & {
  /** CDP monoton zaman damgası (saniye); süre hesabı için. */
  monotonicStart?: number;
};

/** Başlıkları düz metne çevirir, sayısını/uzunluğunu sınırlar ve gizli başlıkları maskeler. */
export function redactHeaders(raw: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return result;
  let count = 0;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count++ >= MAX_HEADERS) break;
    if (REDACTED_HEADERS.has(name.toLowerCase())) {
      result[name] = REDACTED_HEADER_VALUE;
      continue;
    }
    const text = typeof value === 'string' ? value : String(value ?? '');
    result[name] =
      text.length > HEADER_VALUE_MAX_CHARS ? `${text.slice(0, HEADER_VALUE_MAX_CHARS)}…` : text;
  }
  return result;
}

export class NetworkLog {
  private entries: InternalEntry[] = [];
  /** Etkin (yönlendirilmemiş) isteklerin kimliğe göre dizini. */
  private readonly byId = new Map<string, InternalEntry>();
  private redirectCounter = 0;

  constructor(
    private readonly capacity: number = NETWORK_LOG_CAPACITY,
    private readonly now: () => number = Date.now
  ) {}

  /** Bir CDP olayını işler; Network dışındaki olaylar yok sayılır. */
  handleEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Network.requestWillBeSent':
        this.onRequest(params);
        return;
      case 'Network.requestWillBeSentExtraInfo': {
        const entry = this.entryOf(params);
        if (entry) Object.assign(entry.requestHeaders, redactHeaders(params.headers));
        return;
      }
      case 'Network.responseReceived':
        this.onResponse(params);
        return;
      case 'Network.responseReceivedExtraInfo': {
        const entry = this.entryOf(params);
        if (entry) Object.assign(entry.responseHeaders, redactHeaders(params.headers));
        return;
      }
      case 'Network.requestServedFromCache': {
        const entry = this.entryOf(params);
        if (entry) entry.fromCache = true;
        return;
      }
      case 'Network.loadingFinished': {
        const entry = this.entryOf(params);
        if (!entry) return;
        entry.state = 'finished';
        const size = numberOf(params.encodedDataLength);
        if (size !== undefined) entry.encodedSize = size;
        finishTiming(entry, params.timestamp);
        return;
      }
      case 'Network.loadingFailed': {
        const entry = this.entryOf(params);
        if (!entry) return;
        entry.state = 'failed';
        const blocked = stringOf(params.blockedReason);
        entry.failure =
          params.canceled === true
            ? 'canceled'
            : (stringOf(params.errorText) ?? 'failed') + (blocked ? ` (blocked: ${blocked})` : '');
        finishTiming(entry, params.timestamp);
        return;
      }
    }
  }

  /** Bir isteğin başlıklarıyla birlikte kopyası; bilinmeyen kimlik için null. */
  get(requestId: string): NetworkLogEntry | null {
    const entry =
      this.byId.get(requestId) ??
      this.entries.find((candidate) => candidate.requestId === requestId);
    return entry ? toDetail(entry) : null;
  }

  /**
   * Eskiden yeniye özetler. `filter` URL'de büyük/küçük harf duyarsız alt dizgedir;
   * `failedOnly` başarısız ya da 4xx/5xx yanıtlı istekleri seçer; `limit` en yenileri bırakır.
   */
  read(
    options: { filter?: string; failedOnly?: boolean; limit?: number; clear?: boolean } = {}
  ): BrowserNetworkRequest[] {
    let result = this.entries.slice();
    const filter = options.filter?.trim().toLowerCase();
    if (filter) result = result.filter((entry) => entry.url.toLowerCase().includes(filter));
    if (options.failedOnly) {
      result = result.filter(
        (entry) => entry.state === 'failed' || (entry.status !== undefined && entry.status >= 400)
      );
    }
    if (typeof options.limit === 'number' && Number.isFinite(options.limit)) {
      const count = Math.max(0, Math.floor(options.limit));
      result = count === 0 ? [] : result.slice(-count);
    }
    if (options.clear) this.clear();
    return result.map(toSummary);
  }

  clear(): void {
    this.entries = [];
    this.byId.clear();
  }

  private entryOf(params: Record<string, unknown>): InternalEntry | undefined {
    const id = stringOf(params.requestId);
    return id ? this.byId.get(id) : undefined;
  }

  private onRequest(params: Record<string, unknown>): void {
    const requestId = stringOf(params.requestId);
    const request = recordOf(params.request);
    if (!requestId || !request) return;
    const url = stringOf(request.url) ?? '';
    // data: adresleri (satır içi görseller vb.) gürültüdür ve ağa çıkmaz.
    if (url.startsWith('data:')) return;

    const previous = this.byId.get(requestId);
    if (previous) {
      // Yönlendirme: aynı kimlikle yeni istek gelir; öncekini yönlendirme yanıtıyla kapat.
      const redirect = recordOf(params.redirectResponse);
      if (redirect) applyResponse(previous, redirect);
      previous.state = 'finished';
      finishTiming(previous, params.timestamp);
      previous.requestId = `${requestId}:redirect-${++this.redirectCounter}`;
      this.byId.delete(requestId);
    }

    const wallTime = numberOf(params.wallTime);
    const entry: InternalEntry = {
      requestId,
      url: url.length > URL_MAX_CHARS ? `${url.slice(0, URL_MAX_CHARS)}…` : url,
      method: stringOf(request.method) ?? 'GET',
      resourceType: stringOf(params.type) ?? 'Other',
      state: 'pending',
      startTime: wallTime !== undefined ? Math.round(wallTime * 1000) : this.now(),
      requestHeaders: redactHeaders(request.headers),
      responseHeaders: {},
    };
    const monotonic = numberOf(params.timestamp);
    if (monotonic !== undefined) entry.monotonicStart = monotonic;
    this.byId.set(requestId, entry);
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      for (const dropped of this.entries.splice(0, this.entries.length - this.capacity)) {
        if (this.byId.get(dropped.requestId) === dropped) this.byId.delete(dropped.requestId);
      }
    }
  }

  private onResponse(params: Record<string, unknown>): void {
    const entry = this.entryOf(params);
    const response = recordOf(params.response);
    if (!entry || !response) return;
    const type = stringOf(params.type);
    if (type) entry.resourceType = type;
    applyResponse(entry, response);
  }
}

function applyResponse(entry: InternalEntry, response: Record<string, unknown>): void {
  const status = numberOf(response.status);
  if (status !== undefined) entry.status = status;
  const statusText = stringOf(response.statusText);
  if (statusText) entry.statusText = statusText;
  const mimeType = stringOf(response.mimeType);
  if (mimeType) entry.mimeType = mimeType;
  if (response.fromDiskCache === true || response.fromPrefetchCache === true) {
    entry.fromCache = true;
  }
  Object.assign(entry.responseHeaders, redactHeaders(response.headers));
}

function finishTiming(entry: InternalEntry, timestamp: unknown): void {
  const end = numberOf(timestamp);
  if (end !== undefined && entry.monotonicStart !== undefined) {
    entry.durationMs = Math.max(0, Math.round((end - entry.monotonicStart) * 1000));
  }
}

function toSummary(entry: InternalEntry): BrowserNetworkRequest {
  const summary: BrowserNetworkRequest = {
    requestId: entry.requestId,
    url: entry.url,
    method: entry.method,
    resourceType: entry.resourceType,
    state: entry.state,
    startTime: entry.startTime,
  };
  if (entry.status !== undefined) summary.status = entry.status;
  if (entry.statusText !== undefined) summary.statusText = entry.statusText;
  if (entry.mimeType !== undefined) summary.mimeType = entry.mimeType;
  if (entry.durationMs !== undefined) summary.durationMs = entry.durationMs;
  if (entry.encodedSize !== undefined) summary.encodedSize = entry.encodedSize;
  if (entry.fromCache !== undefined) summary.fromCache = entry.fromCache;
  if (entry.failure !== undefined) summary.failure = entry.failure;
  return summary;
}

function toDetail(entry: InternalEntry): NetworkLogEntry {
  return {
    ...toSummary(entry),
    requestHeaders: { ...entry.requestHeaders },
    responseHeaders: { ...entry.responseHeaders },
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const TEXT_MIME_PATTERN =
  /^(text\/|application\/(json|ld\+json|xml|javascript|ecmascript|x-javascript|x-www-form-urlencoded|graphql|problem\+json|manifest\+json)$|image\/svg\+xml$)|\+(json|xml)$/i;

/** Yanıt gövdesinin metin olarak döndürülebilir olup olmadığı (MIME türüne göre). */
export function isTextMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  return TEXT_MIME_PATTERN.test(mimeType.split(';')[0]?.trim() ?? '');
}
