/**
 * Ortak proje hafızasının saf modeli: kayıt adı doğrulaması, sınırlar ve ajan/UI için ortak tipler.
 * Tarayıcı ve Node tarafından paylaşılır; dosya sistemine dokunmaz.
 */

/** Kayıt adı: küçük harf/rakam/tire, rakamla ya da harfle başlar, en çok 64 karakter. */
export const MEMORY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `MEMORY.md` dizin dosyası ile (büyük/küçük harf duyarsız dosya sistemlerinde) çakışan ad. */
const RESERVED_NAMES = new Set([
  'memory',
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export const MEMORY_LIMITS = {
  /** Kayıt gövdesi için bayt sınırı. */
  maxContentBytes: 32 * 1024,
  /** Proje başına kayıt sayısı. */
  maxEntries: 200,
  /** Tek satırlık açıklama uzunluğu (karakter). */
  maxDescriptionChars: 160,
  /** İlk prompt'a eklenen dizin bloğunun toplam karakter sınırı. */
  maxIndexChars: 6000,
} as const;

export type MemoryLimits = { -readonly [K in keyof typeof MEMORY_LIMITS]: number };

export type MemoryEntrySummary = {
  name: string;
  description: string;
  /** Gövdenin bayt boyutu. */
  size: number;
  /** Son değişiklik, epoch ms. */
  updatedAt: number;
};

export type MemoryEntry = MemoryEntrySummary & { content: string };

export type MemoryErrorCode =
  | 'invalid-name'
  | 'invalid-description'
  | 'invalid-content'
  | 'too-large'
  | 'too-many-entries'
  | 'not-found'
  | 'secret-detected'
  | 'unsafe-path'
  | 'invalid-project';

export type MemoryError = { code: MemoryErrorCode; message: string };

/**
 * Ajanın verdiği adı normalleştirip doğrular. Sondaki tek `.md` uzantısı atılır; `..`, `/`, `\`,
 * mutlak yol, boşluk ve büyük harf desene uymadığı için reddedilir.
 */
export function parseMemoryName(
  raw: unknown
): { ok: true; name: string } | { ok: false; error: MemoryError } {
  if (typeof raw !== 'string') {
    return { ok: false, error: { code: 'invalid-name', message: 'Memory name must be a string.' } };
  }
  const name = raw.endsWith('.md') ? raw.slice(0, -3) : raw;
  if (!MEMORY_NAME_PATTERN.test(name) || RESERVED_NAMES.has(name)) {
    return {
      ok: false,
      error: {
        code: 'invalid-name',
        message:
          'Memory names must match [a-z0-9][a-z0-9-]{0,63} (lowercase letters, digits and dashes) and must not be reserved.',
      },
    };
  }
  return { ok: true, name };
}

/** Proje kimliği dizin adı olarak kullanılır; yalnızca güvenli karakterlere izin verilir. */
export function isSafeProjectId(projectId: unknown): projectId is string {
  return typeof projectId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(projectId);
}

/** Açıklamayı tek satıra indirger ve sınırlar; boşsa null. */
export function normalizeDescription(raw: unknown, maxChars: number): string | null {
  if (typeof raw !== 'string') return null;
  const single = raw.replace(/\s+/g, ' ').trim();
  if (!single) return null;
  return single.length > maxChars ? null : single;
}
