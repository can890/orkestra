// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/desktop/src/preview/BrowserImport/SafariCookies.ts
//
// Safari `Cookies.binarycookies` ayrıştırıcısı. Dosya macOS TCC ile korunur: Orkestra'ya Tam Disk
// Erişimi verilmeden okunamaz (EPERM).
import { open, readFile } from 'node:fs/promises';
import {
  cookieScope,
  safariExpiryToUnixSeconds,
  type CookieReadResult,
  type ImportedCookie,
} from './cookie-model';

const COOKIE_PAGE_HEADER_SIZE = 12;
const COOKIE_RECORD_HEADER_SIZE = 56;

const FLAG_SECURE = 0x1;
const FLAG_HTTP_ONLY = 0x4;

export type SafariCookieReadFailure = 'needsFullDiskAccess' | 'readFailed';

export class SafariCookieReadError extends Error {
  constructor(
    readonly reason: SafariCookieReadFailure,
    options?: { cause?: unknown }
  ) {
    super(`Could not read Safari cookies: ${reason}.`, options);
    this.name = 'SafariCookieReadError';
  }
}

function readCString(buffer: Buffer, start: number): string {
  const end = buffer.indexOf(0, start);
  return buffer.toString('utf8', start, end === -1 ? buffer.length : end);
}

/**
 * Biçim: "cook" + büyük-endian sayfa sayısı + sayfa boyutları; her sayfa küçük-endian başlık,
 * çerez ofset tablosu ve kayıtlar içerir. Taşan/çakışan ofsetler uydurma çerez üretmemek için
 * dosyanın tamamını reddettirir.
 */
export function parseBinaryCookies(buffer: Buffer): ImportedCookie[] {
  if (buffer.length < 8 || buffer.toString('latin1', 0, 4) !== 'cook') {
    throw new SafariCookieReadError('readFailed');
  }

  const pageCount = buffer.readUInt32BE(4);
  if (8 + pageCount * 4 > buffer.length) throw new SafariCookieReadError('readFailed');
  const pageSizes: number[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    pageSizes.push(buffer.readUInt32BE(8 + index * 4));
  }

  const cookies: ImportedCookie[] = [];
  let pageStart = 8 + pageCount * 4;

  for (const pageSize of pageSizes) {
    if (pageSize < COOKIE_PAGE_HEADER_SIZE || pageStart + pageSize > buffer.length) {
      throw new SafariCookieReadError('readFailed');
    }
    const page = buffer.subarray(pageStart, pageStart + pageSize);
    pageStart += pageSize;

    // Sayfa gövdesi büyük-endian başlıktan sonra küçük-endian'a geçer.
    const cookieCount = page.readUInt32LE(4);
    const offsetTableEnd = COOKIE_PAGE_HEADER_SIZE + cookieCount * 4;
    if (offsetTableEnd > page.length) throw new SafariCookieReadError('readFailed');
    const accepted: Array<readonly [start: number, end: number]> = [];
    for (let index = 0; index < cookieCount; index += 1) {
      const cookieStart = page.readUInt32LE(8 + index * 4);
      if (cookieStart < offsetTableEnd || cookieStart + COOKIE_RECORD_HEADER_SIZE > page.length) {
        throw new SafariCookieReadError('readFailed');
      }
      const recordSize = page.readUInt32LE(cookieStart);
      const cookieEnd = cookieStart + recordSize;
      if (
        recordSize < COOKIE_RECORD_HEADER_SIZE ||
        cookieEnd > page.length ||
        accepted.some(([start, end]) => cookieStart < end && cookieEnd > start)
      ) {
        throw new SafariCookieReadError('readFailed');
      }
      accepted.push([cookieStart, cookieEnd]);
      const cookie = page.subarray(cookieStart, cookieEnd);

      const flags = cookie.readUInt32LE(8);
      const urlOffset = cookie.readUInt32LE(16);
      const nameOffset = cookie.readUInt32LE(20);
      const pathOffset = cookie.readUInt32LE(24);
      const valueOffset = cookie.readUInt32LE(28);
      const expiry = cookie.readDoubleLE(40);

      if (
        [urlOffset, nameOffset, pathOffset, valueOffset].some(
          (offset) => offset < COOKIE_RECORD_HEADER_SIZE || offset >= cookie.length
        )
      ) {
        throw new SafariCookieReadError('readFailed');
      }
      const domain = readCString(cookie, urlOffset);
      const name = readCString(cookie, nameOffset);
      const path = readCString(cookie, pathOffset) || '/';
      const value = readCString(cookie, valueOffset);
      if (domain === '' || name === '') continue;

      const secure = (flags & FLAG_SECURE) !== 0;
      cookies.push({
        ...cookieScope(domain, path, secure),
        name,
        value,
        path,
        secure,
        httpOnly: (flags & FLAG_HTTP_ONLY) !== 0,
        expirationDate: safariExpiryToUnixSeconds(expiry),
        // Safari'nin SameSite bayrak kodlaması belgelenmemiş; None tahmini kapsamı genişletir.
        sameSite: 'lax',
      });
    }
  }

  // Sayfalardan sonra 8 baytlık sağlama toplamı ve isteğe bağlı uzunluk önekli plist gelir.
  const trailer = buffer.length - pageStart;
  const validTrailer =
    trailer === 0 ||
    trailer === 8 ||
    (trailer >= 12 && trailer === 8 + 4 + buffer.readUInt32BE(pageStart + 8));
  if (!validTrailer) throw new SafariCookieReadError('readFailed');

  return cookies;
}

/** TCC reddi EPERM döndürür; EACCES Tam Disk Erişimi ile çözülemeyen bir POSIX reddidir. */
export function isPermissionDenied(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'EPERM';
}

/** stat Tam Disk Erişimi olmadan da başarılı olur; okunabilirlik ancak açmayla anlaşılır. */
export async function safariAccessDenied(cookiePath: string): Promise<boolean> {
  try {
    const handle = await open(cookiePath, 'r');
    await handle.close();
    return false;
  } catch (error) {
    return isPermissionDenied(error);
  }
}

export async function safariAccessGranted(cookiePath: string): Promise<boolean> {
  try {
    const handle = await open(cookiePath, 'r');
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

export async function readSafariCookies(cookiePath: string): Promise<CookieReadResult> {
  let contents: Buffer;
  try {
    contents = await readFile(cookiePath);
  } catch (error) {
    throw new SafariCookieReadError(
      isPermissionDenied(error) ? 'needsFullDiskAccess' : 'readFailed',
      { cause: error }
    );
  }
  try {
    return {
      cookies: parseBinaryCookies(contents),
      undecryptable: 0,
      partitioned: 0,
      skippedHosts: [],
    };
  } catch (error) {
    if (error instanceof SafariCookieReadError) throw error;
    throw new SafariCookieReadError('readFailed', { cause: error });
  }
}
