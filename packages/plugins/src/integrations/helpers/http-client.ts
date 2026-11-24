import { err, ok, type Result } from '@orkestra/shared';
import type { IntegrationError } from '../types';
import { toIntegrationError } from './error';

/**
 * SDK'sı olmayan REST sağlayıcıları (Bitbucket, Azure DevOps) için küçük, fetch tabanlı JSON
 * istemcisi. Kimlik bilgisi yalnızca `Authorization` başlığında taşınır; hata nesnelerine,
 * mesajlara ya da günlüğe asla yazılmaz. Mutlak URL'ler (ör. sayfalama `next` bağlantıları)
 * yalnızca yapılandırılmış API kökeninde izinlidir; böylece başlık başka bir sunucuya sızmaz.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type HttpRequest = {
  method?: HttpMethod;
  /** API köküne göreli yol (`/user`) ya da aynı kökende mutlak URL. */
  path: string;
  query?: Record<string, string | number | boolean | readonly string[] | undefined>;
  body?: unknown;
  /** `application/json` dışındaki gövde türleri için (ör. JSON Patch). */
  contentType?: string;
};

export type HttpResponse = {
  status: number;
  headers: Headers;
  body: unknown;
};

export type HttpClientOptions = {
  provider: string;
  baseUrl: string;
  authorization: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /**
   * Azure DevOps geçersiz bir PAT için 401 yerine 203 + HTML giriş sayfası döndürür; bu bayrak
   * JSON olmayan başarılı yanıtları kimlik doğrulama hatası sayar.
   */
  treatNonJsonAsAuthFailure?: boolean;
};

/** Ortak hata sözlüğü + (varsa) HTTP durum kodu; mesajlar kimlik bilgisi içermez. */
export type HttpClientError = IntegrationError & { status?: number };

export type HttpClient = {
  readonly baseUrl: string;
  request(request: HttpRequest): Promise<Result<HttpResponse, HttpClientError>>;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/** Durum kodunu taşıyan hata; `toIntegrationError` bunu ortak hata sözlüğüne çevirir. */
class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** Başlıkta geçersiz karakterler, kimlik bilgisini içeren istisnalara yol açabilir. */
const HEADER_SAFE = /^[\x21-\x7e]+$/;

export function isHeaderSafe(value: string): boolean {
  return HEADER_SAFE.test(value);
}

export function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

export function bearerAuthorization(token: string): string {
  return `Bearer ${token}`;
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** `Retry-After` saniye ya da HTTP tarihi olabilir; ISO zaman damgasına çevrilir. */
export function retryAtFromHeader(value: string | null, now = Date.now()): string | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(now + seconds * 1000).toISOString();
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : new Date(date).toISOString();
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const apiOrigin = originOf(baseUrl);
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const provider = options.provider;

  function resolveUrl(request: HttpRequest): string | null {
    let url: URL;
    if (/^https?:\/\//i.test(request.path)) {
      if (originOf(request.path) !== apiOrigin) return null;
      url = new URL(request.path);
    } else {
      const path = request.path.startsWith('/') ? request.path : `/${request.path}`;
      url = new URL(`${baseUrl}${path}`);
    }
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const entry of value) url.searchParams.append(key, entry);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async function request(input: HttpRequest): Promise<Result<HttpResponse, HttpClientError>> {
    const url = resolveUrl(input);
    if (url === null) {
      return err({
        type: 'invalid_input',
        message: `Refusing to send ${provider} credentials to an unexpected host.`,
      });
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
      Authorization: options.authorization,
    };
    let body: string | undefined;
    if (input.body !== undefined) {
      headers['Content-Type'] = input.contentType ?? 'application/json';
      body = JSON.stringify(input.body);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: input.method ?? 'GET',
        headers,
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      // Ağ hataları URL'yi içerebilir ama başlıkları içermez; yine de yalnızca kodu taşırız.
      const code = (error as { cause?: { code?: unknown }; code?: unknown })?.cause?.code;
      const wrapped = Object.assign(new Error(`Unable to reach ${provider}.`), {
        code: typeof code === 'string' ? code : (error as { code?: unknown })?.code,
      });
      const mapped = toIntegrationError(wrapped, provider);
      return err(
        mapped.type === 'generic'
          ? { type: 'host_unreachable', message: `Unable to reach ${provider}.` }
          : mapped
      );
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const mapped = toIntegrationError(
        new HttpStatusError(
          response.status,
          `${provider} request failed (HTTP ${response.status}).`
        ),
        provider
      );
      if (mapped.type === 'rate_limited') {
        const resetAt = retryAtFromHeader(response.headers.get('retry-after'));
        return err({ ...mapped, ...(resetAt ? { resetAt } : {}), status: response.status });
      }
      return err({ ...mapped, status: response.status });
    }

    if (response.status === 204) {
      return ok({ status: response.status, headers: response.headers, body: null });
    }

    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    const looksJson = contentType.includes('json') || /^\s*[[{]/.test(text);
    if (
      options.treatNonJsonAsAuthFailure &&
      (response.status === 203 || (text.trim().length > 0 && !looksJson))
    ) {
      return err({
        type: 'auth_failed',
        message: `${provider} authentication failed. Check your credentials.`,
      });
    }
    if (text.trim().length === 0) {
      return ok({ status: response.status, headers: response.headers, body: null });
    }
    try {
      return ok({ status: response.status, headers: response.headers, body: JSON.parse(text) });
    } catch {
      return err({ type: 'generic', message: `${provider} returned an unreadable response.` });
    }
  }

  return { baseUrl, request };
}
