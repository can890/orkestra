// Özel tema şeması ve sabitleri. Ayar sözleşmesi (paylaşılan manifest) yalnızca bunu içe aktarır;
// böylece tema üreteci (`@orkestra/theme` → colorjs.io) ana sürece taşınmaz.

import { z } from 'zod';
import { normalizeHex } from './color';

export const CUSTOM_THEME_FILE_VERSION = 1 as const;
export const MAX_CUSTOM_THEMES = 50;
export const CUSTOM_THEME_NAME_MAX = 48;

/** Okunur metin için en düşük WCAG kontrastı (T3 ile aynı: 4.5). */
export const TEXT_MIN_CONTRAST = 4.5;
/** Soluk metin ve birincil düğme yazısı için en düşük kontrast. */
export const MUTED_MIN_CONTRAST = 3;

const hexSchema = z
  .string()
  .refine((value) => normalizeHex(value) !== null, 'Expected a color')
  .transform((value) => normalizeHex(value)!);

export const customThemePaletteSchema = z.object({
  /** Uygulama zemini (tuval). Nötr rampanın tonu/doygunluğu ve açıklığı buradan gelir. */
  background: hexSchema,
  /** İsteğe bağlı ana metin rengi; verilmezse nötr rampadan türetilir. */
  foreground: hexSchema.optional(),
  /** Vurgu (birincil düğmeler, seçimler). */
  accent: hexSchema,
  success: hexSchema.optional(),
  danger: hexSchema.optional(),
  warning: hexSchema.optional(),
  info: hexSchema.optional(),
});
export type CustomThemePalette = z.infer<typeof customThemePaletteSchema>;

export const customThemeSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,47})$/, 'Invalid theme id')
    .refine((id) => !RESERVED_THEME_IDS.has(id), 'Reserved theme id'),
  name: z.string().trim().min(1).max(CUSTOM_THEME_NAME_MAX),
  polarity: z.enum(['light', 'dark']),
  palette: customThemePaletteSchema,
  /** `high` yerleşik temalardaki yüksek kontrast eğrisini kullanır. */
  contrast: z.enum(['normal', 'high']).default('normal'),
  /** Canlılık (0 = gri tonlama, 1.15 = yerleşik temalar). */
  vividness: z.number().min(0).max(2).default(1.15),
});
export type CustomTheme = z.infer<typeof customThemeSchema>;

export const RESERVED_THEME_IDS: ReadonlySet<string> = new Set([
  'light',
  'dark',
  'solarized-light',
  'solarized-dark',
  'system',
]);

/** Ad → benzersiz kimlik (küçük harf, tire). */
export function themeIdFromName(name: string, taken: ReadonlySet<string> = new Set()): string {
  const base =
    name
      .replace(/ı/g, 'i')
      .replace(/İ/g, 'I')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'theme';
  const safeBase = RESERVED_THEME_IDS.has(base) ? `${base}-custom` : base;
  let candidate = safeBase;
  for (let n = 2; taken.has(candidate); n++) candidate = `${safeBase}-${n}`;
  return candidate;
}
