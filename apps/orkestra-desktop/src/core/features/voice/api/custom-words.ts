/**
 * Turkish-Unicode-safe custom dictionary post-processor for voice dictation (Feature #9).
 * Adapted from T3 Code (MIT License) customWords.ts & postProcessing.ts.
 *
 * Handles:
 * - Turkish dotted/dotless İ/I/ı folding (`foldTurkishForMatch`)
 * - Turkish apostrophe suffixes (`Supabase'de`, `TypeScript'in` -> preserves suffix!)
 * - Exact casing restoration (`Next.js`, `PostgreSQL`, `Sovra`, `Tailscale`)
 */

export function foldTurkishForMatch(input: string): string {
  return input
    .replace(/İ/g, 'i')
    .replace(/I/g, 'i')
    .replace(/ı/g, 'i')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces case-insensitive / Turkish-folded matches of custom technical words
 * while preserving attached Turkish apostrophe suffixes (e.g. `supabase'de` -> `Supabase'de`).
 */
export function applyCustomWords(text: string, customWords: readonly string[]): string {
  if (!text || customWords.length === 0) return text;
  const cleaned = customWords
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .sort((a, b) => b.length - a.length);
  if (cleaned.length === 0) return text;

  // Build lookup by Turkish-folded form
  const byFolded = new Map<string, string>();
  for (const word of cleaned) {
    const key = foldTurkishForMatch(word);
    if (!byFolded.has(key)) byFolded.set(key, word);
  }

  // Build regex over folded string, then splice original text at exact indices
  const foldedText = foldTurkishForMatch(text);
  const pattern = [...byFolded.keys()].map(escapeRegExp).join('|');
  if (!pattern) return text;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(${pattern})(?=(?:'[\\p{L}]+)?(?![\\p{L}\\p{N}_]))`, 'gu');

  let out = '';
  let lastIndex = 0;
  for (const match of foldedText.matchAll(re)) {
    const start = match.index ?? 0;
    const matchedFolded = match[1]!;
    const replacement = byFolded.get(matchedFolded);
    if (!replacement) continue;
    out += text.slice(lastIndex, start) + replacement;
    lastIndex = start + matchedFolded.length;
  }
  out += text.slice(lastIndex);
  return out;
}

/** Builds a concise Whisper initial prompt hint from custom words (max ~220 chars). */
export function buildWhisperCustomWordsPrompt(customWords: readonly string[]): string | undefined {
  const unique = [...new Set(customWords.map((w) => w.trim()).filter(Boolean))];
  if (unique.length === 0) return undefined;
  let prompt = '';
  for (const word of unique) {
    const candidate = prompt ? `${prompt}, ${word}` : word;
    if (candidate.length > 220) break;
    prompt = candidate;
  }
  return prompt || undefined;
}
