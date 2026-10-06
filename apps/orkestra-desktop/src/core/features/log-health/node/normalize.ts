import { createHash } from 'node:crypto';
import type { LogHealthLevel } from '../api/contract';

/** Şablon metinleri için üst sınır; uzun mesajlar gruplamayı bozmasın. */
const MAX_TEMPLATE_LENGTH = 240;

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`)\]}>,]+/gi;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// En az iki bölümden oluşan mutlak yollar (POSIX veya Windows sürücü harfli).
const PATH_PATTERN = /(?:\b[A-Za-z]:)?(?:[\\/][^\s\\/'"`,;:()<>{}|]+){2,}[\\/]?/g;
const HEX_PATTERN = /\b[0-9a-f]{7,}\b/gi;
const NUMBER_PATTERN = /\d+(?:[.,:]\d+)*/g;
const WHITESPACE_PATTERN = /\s+/g;

/**
 * Bir günlük mesajını gruplama şablonuna çevirir: URL'ler, UUID'ler, mutlak
 * yollar, uzun onaltılık değerler ve sayılar yer tutuculara indirgenir. Böylece
 * yalnızca kimliği veya süresi değişen tekrarlar aynı gruba düşer.
 */
export function normalizeLogText(value: string): string {
  return value
    .replace(URL_PATTERN, '<url>')
    .replace(UUID_PATTERN, '<id>')
    .replace(PATH_PATTERN, '<path>')
    .replace(HEX_PATTERN, (match) => (/\d/.test(match) ? '<hex>' : match))
    .replace(NUMBER_PATTERN, '<n>')
    .replace(WHITESPACE_PATTERN, ' ')
    .trim()
    .slice(0, MAX_TEMPLATE_LENGTH);
}

/** `Ad: mesaj` biçiminde normalleştirilmiş hata imzası; hata yoksa null. */
export function normalizeErrorSignature(
  error: { name?: string | null; message?: string | null; code?: string | null } | undefined
): string | null {
  if (!error) return null;
  const name = error.name?.trim() || null;
  const message = error.message ? normalizeLogText(error.message) : '';
  const code = error.code?.trim() ? ` [${error.code.trim()}]` : '';
  if (!name && !message) return code ? code.trim() : null;
  if (!name) return `${message}${code}`;
  if (!message) return `${name}${code}`;
  return `${name}: ${message}${code}`;
}

/** Seviye + şablon + hata imzasından kararlı, kısa grup anahtarı üretir. */
export function logGroupKey(
  level: LogHealthLevel,
  template: string,
  errorSignature: string | null
): string {
  return createHash('sha1')
    .update(`${level}\u0000${template}\u0000${errorSignature ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}
