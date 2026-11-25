/** Kapsayıcı bayt aralığı: `[start, end]`. */
export type ByteRange = { start: number; end: number };

export type RangeRequest =
  /** Range başlığı yok veya `bytes` dışı bir birim: tam yanıt (200). */
  | { kind: 'full' }
  | { kind: 'range'; range: ByteRange }
  /** Sözdizimi bozuk ya da dosya boyutuyla karşılanamaz: 416. */
  | { kind: 'unsatisfiable' };

const RANGE_SPEC = /^(\d*)-(\d*)$/;

/**
 * Tek aralıklı HTTP Range başlığını çözer (RFC 9110 §14). Çoklu aralıkta yalnız ilk aralık
 * sunulur; medya öğeleri zaten tek aralık ister. Boş dosyada her aralık karşılanamaz.
 */
export function parseRangeHeader(header: string | null | undefined, size: number): RangeRequest {
  if (header === null || header === undefined) return { kind: 'full' };
  const trimmed = header.trim();
  const eq = trimmed.indexOf('=');
  if (eq < 0) return { kind: 'unsatisfiable' };
  if (trimmed.slice(0, eq).trim().toLowerCase() !== 'bytes') return { kind: 'full' };
  const first = trimmed
    .slice(eq + 1)
    .split(',')[0]
    ?.trim();
  const match = first ? RANGE_SPEC.exec(first) : null;
  if (!match) return { kind: 'unsatisfiable' };
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return { kind: 'unsatisfiable' };

  if (rawStart === '') {
    // Sonek aralığı: son N bayt.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix === 0 || size === 0) {
      return { kind: 'unsatisfiable' };
    }
    return { kind: 'range', range: { start: Math.max(0, size - suffix), end: size - 1 } };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' };
  if (rawEnd === '') return { kind: 'range', range: { start, end: size - 1 } };
  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'unsatisfiable' };
  return { kind: 'range', range: { start, end: Math.min(end, size - 1) } };
}

export function contentRangeHeader(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`;
}
