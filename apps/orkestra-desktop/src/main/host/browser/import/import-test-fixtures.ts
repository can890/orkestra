// Yalnızca testler için: gerçek tarayıcı depolarına dokunmadan, bilinen bir test anahtarıyla
// Chromium, Firefox ve Safari biçiminde sentetik çerez dosyaları üretir.
import { createCipheriv, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { CHROMIUM_CBC_IV, CHROMIUM_DOMAIN_BINDING_SCHEMA_VERSION } from './chromium-cookies';
import { APPLE_EPOCH_OFFSET_SECONDS, WEBKIT_EPOCH_OFFSET_SECONDS } from './cookie-model';

export const TEST_SAFE_STORAGE_PASSWORD = 'orkestra-test-safe-storage-password';

export function encryptChromiumValue(input: {
  value: string;
  key: Buffer;
  hostKey: string;
  schemaVersion: number;
  prefix?: 'v10' | 'v11';
}): Buffer {
  let plaintext = Buffer.from(input.value, 'utf8');
  if (input.schemaVersion >= CHROMIUM_DOMAIN_BINDING_SCHEMA_VERSION) {
    const hash = createHash('sha256').update(input.hostKey).digest();
    plaintext = Buffer.concat([hash, plaintext]);
  }
  const cipher = createCipheriv('aes-128-cbc', input.key, CHROMIUM_CBC_IV);
  return Buffer.concat([
    Buffer.from(input.prefix ?? 'v10', 'latin1'),
    cipher.update(plaintext),
    cipher.final(),
  ]);
}

/** UNIX saniyesi → Chromium 1601 tabanlı mikrosaniye (BigInt; güvenli tamsayı aralığını aşar). */
export function unixToChromiumMicros(unixSeconds: number): bigint {
  return (BigInt(unixSeconds) + BigInt(WEBKIT_EPOCH_OFFSET_SECONDS)) * 1_000_000n;
}

export type ChromiumFixtureRow = {
  hostKey: string;
  name: string;
  value?: string;
  encryptedValue?: Buffer;
  path?: string;
  expiresUtc?: bigint;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: number;
  topFrameSiteKey?: string;
};

export function createChromiumCookieDb(
  filePath: string,
  input: { schemaVersion: number; rows: ChromiumFixtureRow[] }
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  try {
    const hasPartitionKey = input.schemaVersion >= 15;
    db.exec(`create table meta (key longvarchar not null unique primary key, value longvarchar)`);
    db.prepare(`insert into meta (key, value) values ('version', ?)`).run(
      String(input.schemaVersion)
    );
    db.exec(`create table cookies (
      creation_utc integer not null,
      host_key text not null,
      ${hasPartitionKey ? "top_frame_site_key text not null default ''," : ''}
      name text not null,
      value text not null,
      encrypted_value blob default '',
      path text not null,
      expires_utc integer not null,
      is_secure integer not null,
      is_httponly integer not null,
      samesite integer not null default -1
    )`);
    const insert = db.prepare(
      hasPartitionKey
        ? `insert into cookies (creation_utc, host_key, top_frame_site_key, name, value,
             encrypted_value, path, expires_utc, is_secure, is_httponly, samesite)
           values (0, @hostKey, @topFrameSiteKey, @name, @value, @encryptedValue, @path,
             @expiresUtc, @secure, @httpOnly, @sameSite)`
        : `insert into cookies (creation_utc, host_key, name, value, encrypted_value, path,
             expires_utc, is_secure, is_httponly, samesite)
           values (0, @hostKey, @name, @value, @encryptedValue, @path, @expiresUtc, @secure,
             @httpOnly, @sameSite)`
    );
    for (const row of input.rows) {
      insert.run({
        hostKey: row.hostKey,
        ...(hasPartitionKey ? { topFrameSiteKey: row.topFrameSiteKey ?? '' } : {}),
        name: row.name,
        value: row.value ?? '',
        encryptedValue: row.encryptedValue ?? Buffer.alloc(0),
        path: row.path ?? '/',
        expiresUtc: row.expiresUtc ?? 0n,
        secure: row.secure ? 1 : 0,
        httpOnly: row.httpOnly ? 1 : 0,
        sameSite: row.sameSite ?? -1,
      });
    }
  } finally {
    db.close();
  }
}

export type FirefoxFixtureRow = {
  host: string;
  name: string;
  value: string;
  path?: string;
  expiry?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: number | null;
  rawSameSite?: number | null;
  originAttributes?: string;
};

export function createFirefoxCookieDb(
  filePath: string,
  input: { userVersion: number; rows: FirefoxFixtureRow[] }
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  try {
    db.exec(`create table moz_cookies (
      id integer primary key,
      originAttributes text not null default '',
      name text, value text, host text, path text,
      expiry integer, lastAccessed integer, creationTime integer,
      isSecure integer, isHttpOnly integer, inBrowserElement integer default 0,
      sameSite integer, rawSameSite integer default 0, schemeMap integer default 0
    )`);
    db.pragma(`user_version = ${input.userVersion}`);
    const insert = db.prepare(`insert into moz_cookies
      (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite, rawSameSite)
      values (@originAttributes, @name, @value, @host, @path, @expiry, @secure, @httpOnly,
        @sameSite, @rawSameSite)`);
    for (const row of input.rows) {
      insert.run({
        originAttributes: row.originAttributes ?? '',
        name: row.name,
        value: row.value,
        host: row.host,
        path: row.path ?? '/',
        expiry: row.expiry ?? 0,
        secure: row.secure ? 1 : 0,
        httpOnly: row.httpOnly ? 1 : 0,
        sameSite: row.sameSite === undefined ? 0 : row.sameSite,
        rawSameSite: row.rawSameSite === undefined ? 0 : row.rawSameSite,
      });
    }
  } finally {
    db.close();
  }
}

export type SafariFixtureCookie = {
  domain: string;
  name: string;
  value: string;
  path?: string;
  /** UNIX saniyesi; verilmezse oturum çerezi (0). */
  expiresUnix?: number;
  secure?: boolean;
  httpOnly?: boolean;
};

function safariRecord(cookie: SafariFixtureCookie): Buffer {
  const strings = [cookie.domain, cookie.name, cookie.path ?? '/', cookie.value].map((value) =>
    Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])])
  );
  const header = Buffer.alloc(56);
  let offset = 56;
  const offsets: number[] = [];
  for (const part of strings) {
    offsets.push(offset);
    offset += part.length;
  }
  header.writeUInt32LE(offset, 0);
  header.writeUInt32LE((cookie.secure ? 0x1 : 0) | (cookie.httpOnly ? 0x4 : 0), 8);
  header.writeUInt32LE(offsets[0], 16);
  header.writeUInt32LE(offsets[1], 20);
  header.writeUInt32LE(offsets[2], 24);
  header.writeUInt32LE(offsets[3], 28);
  header.writeDoubleLE(
    cookie.expiresUnix === undefined ? 0 : cookie.expiresUnix - APPLE_EPOCH_OFFSET_SECONDS,
    40
  );
  header.writeDoubleLE(0, 48);
  return Buffer.concat([header, ...strings]);
}

/** Elle kurulmuş `Cookies.binarycookies`: her iç dizi bir sayfa. */
export function buildBinaryCookies(pages: SafariFixtureCookie[][]): Buffer {
  const pageBuffers = pages.map((cookies) => {
    const records = cookies.map(safariRecord);
    const tableEnd = 12 + records.length * 4;
    const head = Buffer.alloc(tableEnd);
    head.writeUInt32BE(0x00000100, 0);
    head.writeUInt32LE(records.length, 4);
    let cursor = tableEnd;
    records.forEach((record, index) => {
      head.writeUInt32LE(cursor, 8 + index * 4);
      cursor += record.length;
    });
    return Buffer.concat([head, ...records]);
  });
  const header = Buffer.alloc(8 + pageBuffers.length * 4);
  header.write('cook', 0, 'latin1');
  header.writeUInt32BE(pageBuffers.length, 4);
  pageBuffers.forEach((page, index) => header.writeUInt32BE(page.length, 8 + index * 4));
  // 8 baytlık sağlama toplamı.
  return Buffer.concat([header, ...pageBuffers, Buffer.alloc(8)]);
}
