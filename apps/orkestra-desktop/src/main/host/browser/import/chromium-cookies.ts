// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/desktop/src/preview/BrowserImport/ChromiumCookies.ts
//
// Chromium çerez veritabanı (Cookies / Network/Cookies) okuyucusu ve OSCrypt v10/v11
// (AES-128-CBC + PBKDF2) şifre çözümü.
import { createDecipheriv, createHash } from 'node:crypto';
import { ChromiumKeyError, type ChromiumKeyMaterial } from './chromium-keys';
import { hasTable, withCookieDatabaseSnapshot, type CookieSqlite } from './cookie-database';
import {
  bareHost,
  chromiumExpirySecondsToUnixSeconds,
  cookieScope,
  type CookieReadResult,
  type ImportedCookie,
} from './cookie-model';

/** OSCrypt CBC kipi kayıt başına IV yerine 16 boşluktan oluşan sabit bir IV kullanır. */
export const CHROMIUM_CBC_IV = Buffer.alloc(16, 0x20);

/** Chromium 127+ (meta sürümü 24+) düz metnin başına host_key'in SHA-256 özetini ekler. */
export const CHROMIUM_DOMAIN_BINDING_SCHEMA_VERSION = 24;
/** `top_frame_site_key` (bölümlenmiş çerez) sütunu meta sürümü 15 ile geldi. */
const CHROMIUM_PARTITION_KEY_SCHEMA_VERSION = 15;

/** SameSite sütunu: -1 belirtilmemiş, 0 None, 1 Lax, 2 Strict. Belirsiz değer genişletilmez. */
export function chromiumSameSite(value: number): ImportedCookie['sameSite'] {
  if (value === 0) return 'no_restriction';
  if (value === 1) return 'lax';
  if (value === 2) return 'strict';
  return 'unspecified';
}

function stripDomainBinding(plaintext: Buffer, domain: string, schemaVersion: number) {
  if (schemaVersion < CHROMIUM_DOMAIN_BINDING_SCHEMA_VERSION) return plaintext;
  const domainHash = createHash('sha256').update(domain).digest();
  return plaintext.length >= 32 && plaintext.subarray(0, 32).equals(domainHash)
    ? plaintext.subarray(32)
    : null;
}

function decryptCbc(
  payload: Buffer,
  key: Buffer,
  domain: string,
  schemaVersion: number
): string | null {
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, CHROMIUM_CBC_IV);
    decipher.setAutoPadding(true);
    const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
    return stripDomainBinding(plaintext, domain, schemaVersion)?.toString('utf8') ?? null;
  } catch {
    return null;
  }
}

/**
 * Tek bir `encrypted_value` değerinin şifresini çözer; çözülemezse `null` döner.
 * `domain` satırın `host_key` değeridir (alan bağlama özeti bunun üzerinden hesaplanır).
 */
export function decryptChromiumValue(
  encrypted: Uint8Array,
  keys: ChromiumKeyMaterial,
  domain: string,
  schemaVersion = 23
): string | null {
  const buffer = Buffer.from(encrypted);
  if (buffer.length === 0) return '';
  const prefix = buffer.subarray(0, 3).toString('latin1');
  const payload = buffer.subarray(3);

  if (prefix === 'v10') {
    if (!keys.cbcV10) return null;
    return (
      decryptCbc(payload, keys.cbcV10, domain, schemaVersion) ??
      (keys.cbcEmpty ? decryptCbc(payload, keys.cbcEmpty, domain, schemaVersion) : null)
    );
  }
  if (prefix === 'v11') {
    if (!keys.cbcV11) return null;
    return (
      decryptCbc(payload, keys.cbcV11, domain, schemaVersion) ??
      (keys.cbcEmpty ? decryptCbc(payload, keys.cbcEmpty, domain, schemaVersion) : null)
    );
  }
  // Önek yoksa çok eski, şifrelenmemiş bir kayıttır.
  return stripDomainBinding(buffer, domain, schemaVersion)?.toString('utf8') ?? null;
}

type ChromiumCookieRow = {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array | null;
  path: string;
  expires_seconds: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
  top_frame_site_key: string | null;
};

export function readChromiumSchemaVersion(db: CookieSqlite): number {
  if (!hasTable(db, 'meta')) return 0;
  const row = db.prepare(`select value from meta where key = 'version' limit 1`).get() as
    | { value: unknown }
    | undefined;
  const parsed = Number(row?.value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** Açılmış (kopya) bir Chromium çerez veritabanını okur. */
export function readChromiumCookieRows(db: CookieSqlite, keys: ChromiumKeyMaterial) {
  // Chromium hasarlı bir veritabanını tablosuz bir dosyaya indirger; boş içe aktarılır.
  if (!hasTable(db, 'cookies')) {
    return { cookies: [], undecryptable: 0, partitioned: 0, skippedHosts: [] };
  }
  const schemaVersion = readChromiumSchemaVersion(db);
  const partitionColumn =
    schemaVersion >= CHROMIUM_PARTITION_KEY_SCHEMA_VERSION
      ? 'top_frame_site_key'
      : `'' as top_frame_site_key`;
  const rows = db
    .prepare(
      `select host_key, name, value, encrypted_value, path,
              expires_utc / 1000000 as expires_seconds, is_secure, is_httponly,
              samesite, ${partitionColumn} from cookies`
    )
    .all() as ChromiumCookieRow[];

  const cookies: ImportedCookie[] = [];
  let undecryptable = 0;
  let partitioned = 0;
  const skippedHosts = new Set<string>();
  for (const row of rows) {
    // Bölümlenmiş (CHIPS) çerezler Electron'da temsil edilemez; atlanır.
    if (row.top_frame_site_key) {
      partitioned += 1;
      skippedHosts.add(bareHost(row.host_key));
      continue;
    }
    const encrypted = row.encrypted_value ?? new Uint8Array();
    const value =
      encrypted.length === 0
        ? row.value
        : decryptChromiumValue(encrypted, keys, row.host_key, schemaVersion);
    if (value === null) {
      undecryptable += 1;
      skippedHosts.add(bareHost(row.host_key));
      continue;
    }
    const secure = row.is_secure === 1;
    const scope = cookieScope(row.host_key, row.path || '/', secure);
    cookies.push({
      url: scope.url,
      name: row.name,
      value,
      domain: scope.domain,
      path: row.path || '/',
      secure,
      httpOnly: row.is_httponly === 1,
      expirationDate: chromiumExpirySecondsToUnixSeconds(Number(row.expires_seconds)),
      sameSite: chromiumSameSite(Number(row.samesite)),
    });
  }

  // v11 anahtarı alınamadıysa ve hiçbir çerez çözülemediyse asıl neden anahtar zinciridir.
  if (
    cookies.length === 0 &&
    keys.cbcV11Error !== undefined &&
    rows.some(
      (row) =>
        !row.top_frame_site_key &&
        row.encrypted_value !== null &&
        Buffer.from(row.encrypted_value.subarray(0, 3)).toString('latin1') === 'v11'
    )
  ) {
    throw keys.cbcV11Error;
  }
  return {
    cookies,
    undecryptable,
    partitioned,
    skippedHosts: [...skippedHosts],
  } satisfies CookieReadResult;
}

export class ChromiumCookieReadError extends Error {
  constructor(
    readonly reason: ChromiumKeyError['reason'],
    options?: { cause?: unknown }
  ) {
    super(`Could not read Chromium cookies: ${reason}.`, options);
    this.name = 'ChromiumCookieReadError';
  }
}

/** Kopyadan okur; anahtar materyali çağıran tarafından (anahtar zinciri istemiyle) sağlanır. */
export async function readChromiumCookies(
  cookieDatabasePath: string,
  keys: ChromiumKeyMaterial,
  options: { tempRoot?: string } = {}
): Promise<CookieReadResult> {
  try {
    return await withCookieDatabaseSnapshot(
      cookieDatabasePath,
      (db) => readChromiumCookieRows(db, keys),
      options
    );
  } catch (error) {
    if (error instanceof ChromiumKeyError) throw new ChromiumCookieReadError(error.reason);
    throw new ChromiumCookieReadError('readFailed', { cause: error });
  }
}
