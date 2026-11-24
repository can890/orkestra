// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/desktop/src/preview/BrowserImport/CookieDatabase.ts
//
// Tarayıcı okuyucularının ürettiği ortak çerez modeli ve Electron `cookies.set` biçimine
// dönüşüm yardımcıları. Çerez değerleri hiçbir yerde loglanmaz.

export type ImportedCookieSameSite = 'unspecified' | 'no_restriction' | 'lax' | 'strict';

export type ImportedCookie = {
  url: string;
  name: string;
  value: string;
  /**
   * Yalnızca alan çerezlerinde (`.example.com`) dolu. Host-only çerezlerde boş bırakılır:
   * Electron verilen her alanı genişletir ve `__Host-` çerezlerini alanla reddeder.
   */
  domain: string | undefined;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** UNIX saniyesi; oturum çerezlerinde yok. */
  expirationDate: number | undefined;
  sameSite: ImportedCookieSameSite;
};

export type CookieReadResult = {
  cookies: ImportedCookie[];
  /** Şifresi çözülemeyen çerezler. */
  undecryptable: number;
  /** Bölümlenmiş (CHIPS / üst çerçeveye bağlı) çerezler; Electron bunları temsil edemez. */
  partitioned: number;
  /** Atlanan çerezlerin alan adları (değerleri değil). */
  skippedHosts: string[];
};

/** Chromium zaman damgaları 1601-01-01'den bu yana mikrosaniye sayar. */
export const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600;
/** Safari zaman damgaları 2001-01-01'den bu yana saniye sayar. */
export const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;

/** Chromium `expires_utc` (1601 tabanlı mikrosaniye) → UNIX saniyesi; 0 oturum çerezidir. */
export function chromiumExpiryToUnixSeconds(expiresUtc: number | bigint): number | undefined {
  const micros = typeof expiresUtc === 'bigint' ? expiresUtc : BigInt(Math.trunc(expiresUtc));
  if (micros <= 0n) return undefined;
  return chromiumExpirySecondsToUnixSeconds(Number(micros / 1_000_000n));
}

/**
 * SQL içinde saniyeye bölünmüş Chromium süresi → UNIX saniyesi. Mikrosaniye değerleri JavaScript'in
 * güvenli tamsayı aralığını aşabildiği için okuyucu bölmeyi SQLite'ta yapar.
 */
export function chromiumExpirySecondsToUnixSeconds(webkitSeconds: number): number | undefined {
  if (!Number.isFinite(webkitSeconds) || webkitSeconds <= 0) return undefined;
  return Math.trunc(webkitSeconds) - WEBKIT_EPOCH_OFFSET_SECONDS;
}

/** Safari 2001 tabanlı saniye → UNIX saniyesi; 0 ya da negatif oturum çerezidir. */
export function safariExpiryToUnixSeconds(appleSeconds: number): number | undefined {
  if (!Number.isFinite(appleSeconds) || appleSeconds <= 0) return undefined;
  return Math.floor(appleSeconds) + APPLE_EPOCH_OFFSET_SECONDS;
}

export const bareHost = (host: string): string => (host.startsWith('.') ? host.slice(1) : host);

/**
 * Çerezin yazılacağı URL'yi ve alanını üretir. Nokta ile başlayan host alan çerezidir; diğerleri
 * host-only kalır. IPv6 adresleri köşeli paranteze alınır.
 */
export function cookieScope(
  host: string,
  path: string,
  secure: boolean
): { url: string; domain: string | undefined } {
  const isDomainCookie = host.startsWith('.');
  const unwrapped = bareHost(host);
  const authority =
    unwrapped.includes(':') && !(unwrapped.startsWith('[') && unwrapped.endsWith(']'))
      ? `[${unwrapped}]`
      : unwrapped;
  return {
    url: `${secure ? 'https' : 'http'}://${authority}${path}`,
    domain: isDomainCookie ? host : undefined,
  };
}
