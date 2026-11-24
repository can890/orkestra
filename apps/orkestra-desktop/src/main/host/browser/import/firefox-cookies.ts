// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/desktop/src/preview/BrowserImport/FirefoxCookies.ts
//
// Firefox ailesi (Firefox, Zen) `cookies.sqlite` okuyucusu. Değerler şifresizdir.
import { withCookieDatabaseSnapshot, type CookieSqlite } from './cookie-database';
import { cookieScope, type CookieReadResult, type ImportedCookie } from './cookie-model';

const SAMESITE_NONE = 0;
const SAMESITE_LAX = 1;
const SAMESITE_STRICT = 2;

/** 10–14 şemaları sameSite'ı varsayılan Lax yaptı; rawSameSite asıl beyan edilen değeri tutar. */
const FIREFOX_RAW_SAMESITE_FIRST_SCHEMA = 10;
const FIREFOX_RAW_SAMESITE_LAST_SCHEMA = 14;
/** Şema 16+ süreyi milisaniye olarak saklar; eskiler saniye. */
export const FIREFOX_EXPIRY_MILLISECONDS_SCHEMA = 16;

/** Belirsiz ve bilinmeyen SameSite değerleri `unspecified` kalır; None'a çevirmek kapsamı genişletir. */
export function firefoxSameSite(
  value: number | null,
  rawValue: number | null
): ImportedCookie['sameSite'] {
  if (value === null) return 'unspecified';
  if (value === SAMESITE_LAX && rawValue === SAMESITE_NONE) return 'unspecified';
  if (value === SAMESITE_NONE) return 'no_restriction';
  if (value === SAMESITE_LAX) return 'lax';
  if (value === SAMESITE_STRICT) return 'strict';
  return 'unspecified';
}

export function firefoxExpiryToUnixSeconds(
  expiry: number,
  schemaVersion: number
): number | undefined {
  if (!Number.isFinite(expiry) || expiry <= 0) return undefined;
  return schemaVersion >= FIREFOX_EXPIRY_MILLISECONDS_SCHEMA ? Math.floor(expiry / 1000) : expiry;
}

type FirefoxCookieRow = {
  host: string;
  name: string;
  value: string;
  path: string;
  expiry: number;
  isSecure: number;
  isHttpOnly: number;
  sameSite: number | null;
  rawSameSite: number | null;
};

export function readFirefoxCookieRows(db: CookieSqlite): CookieReadResult {
  const versionRow = db.prepare('pragma user_version').get() as { user_version?: number };
  const schemaVersion = versionRow?.user_version ?? 0;
  const hasRawSameSite =
    schemaVersion >= FIREFOX_RAW_SAMESITE_FIRST_SCHEMA &&
    schemaVersion <= FIREFOX_RAW_SAMESITE_LAST_SCHEMA;
  // Kapsayıcı (container), özel pencere ve bölümlenmiş çerezler originAttributes taşır; Electron
  // bunları temsil edemez, ayrı oturumları birleştirmemek için atlanır.
  const partitionedRow = db
    .prepare(`select count(*) as count from moz_cookies where originAttributes != ''`)
    .get() as { count: number };
  const skippedHosts = (
    db
      .prepare(`select distinct host from moz_cookies where originAttributes != '' limit 20`)
      .all() as Array<{ host: string }>
  ).map((row) => (row.host.startsWith('.') ? row.host.slice(1) : row.host));
  const rows = db
    .prepare(
      `select host, name, value, path, expiry, isSecure, isHttpOnly, sameSite,
              ${hasRawSameSite ? 'rawSameSite' : 'null as rawSameSite'}
         from moz_cookies
        where originAttributes = ''`
    )
    .all() as FirefoxCookieRow[];

  const cookies = rows.map((row) => {
    const secure = row.isSecure === 1;
    const path = row.path || '/';
    const scope = cookieScope(row.host, path, secure);
    return {
      url: scope.url,
      name: row.name,
      value: row.value,
      domain: scope.domain,
      path,
      secure,
      httpOnly: row.isHttpOnly === 1,
      expirationDate: firefoxExpiryToUnixSeconds(Number(row.expiry), schemaVersion),
      sameSite: firefoxSameSite(row.sameSite, row.rawSameSite),
    } satisfies ImportedCookie;
  });
  return { cookies, undecryptable: 0, partitioned: partitionedRow.count, skippedHosts };
}

export async function readFirefoxCookies(
  cookieDatabasePath: string,
  options: { tempRoot?: string } = {}
): Promise<CookieReadResult> {
  return withCookieDatabaseSnapshot(cookieDatabasePath, readFirefoxCookieRows, options);
}
