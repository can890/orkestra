// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src/themePalette.ts
//
// Kullanıcı tanımlı temalar. T3'ün "palet" kavramı Orkestra'nın gerçek token sistemine şöyle
// eşlenir: kullanıcı yalnızca birkaç taban renk seçer (zemin, metin, vurgu, durum renkleri);
// tüm token kümesi yerleşik temalarla AYNI üreteçle (`@orkestra/theme` → defineTheme) türetilir.
// Böylece yüzlerce ham değişken açığa çıkmaz ve özel temalar yerleşik temalarla aynı yapıda olur.

import { defineTheme, type ThemeInput } from '@orkestra/theme';
import { contrastRatio, parseColor, readableColorOn, rgbToOklch, toHex, type Rgb } from './color';
import {
  CUSTOM_THEME_FILE_VERSION,
  CUSTOM_THEME_NAME_MAX,
  customThemeSchema,
  MUTED_MIN_CONTRAST,
  RESERVED_THEME_IDS,
  TEXT_MIN_CONTRAST,
  themeIdFromName,
  type CustomTheme,
  type CustomThemePalette,
} from './custom-theme-schema';

export * from './custom-theme-schema';

// ── Yerleşik temalardan başlangıç ─────────────────────────────────────────────

/** Yerleşik temaların taban renkleri (packages/theme/src/themes/*.theme.ts ile uyumlu). */
export const BUILT_IN_THEME_SEEDS: ReadonlyArray<{
  id: string;
  name: string;
  polarity: 'light' | 'dark';
  palette: CustomThemePalette;
}> = [
  {
    id: 'light',
    name: 'Light',
    polarity: 'light',
    palette: {
      background: '#fcfcfc',
      accent: '#008753',
      success: '#2b9a3c',
      danger: '#dc3b3b',
      warning: '#d8a100',
      info: '#0f7ae8',
    },
  },
  {
    id: 'dark',
    name: 'Dark',
    polarity: 'dark',
    palette: {
      background: '#111111',
      accent: '#3bb387',
      success: '#3fa24a',
      danger: '#e5484d',
      warning: '#ffc53d',
      info: '#3e8fe6',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    polarity: 'light',
    palette: {
      background: '#fdf6e3',
      foreground: '#586e75',
      accent: '#268bd2',
      success: '#859900',
      danger: '#dc322f',
      warning: '#b58900',
      info: '#268bd2',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    polarity: 'dark',
    palette: {
      background: '#002b36',
      foreground: '#93a1a1',
      accent: '#268bd2',
      success: '#859900',
      danger: '#dc322f',
      warning: '#b58900',
      info: '#268bd2',
    },
  },
];

/** Var olan (yerleşik ya da özel) bir temadan yeni özel tema oluşturur. */
export function createThemeFrom(
  source: Pick<CustomTheme, 'name' | 'polarity' | 'palette'> &
    Partial<Pick<CustomTheme, 'contrast' | 'vividness'>>,
  name: string,
  taken: ReadonlySet<string>
): CustomTheme {
  const trimmed = name.trim().slice(0, CUSTOM_THEME_NAME_MAX) || 'Custom theme';
  return customThemeSchema.parse({
    id: themeIdFromName(trimmed, taken),
    name: trimmed,
    polarity: source.polarity,
    palette: { ...source.palette },
    contrast: source.contrast ?? 'normal',
    vividness: source.vividness ?? 1.15,
  });
}

/** "Kopya" adıyla çoğaltır. */
export function duplicateTheme(theme: CustomTheme, taken: ReadonlySet<string>): CustomTheme {
  return createThemeFrom(theme, `${theme.name} copy`.slice(0, CUSTOM_THEME_NAME_MAX), taken);
}

// ── Palet → token türetimi ────────────────────────────────────────────────────

/** Varsayılan yüzey basamakları (packages/theme/src/core/contract/targets.ts SURFACE_L). */
const DEFAULT_SURFACE_L = {
  light: {
    sunken: 0.95,
    base: 0.972,
    'base-emphasis': 0.982,
    elevated: 0.993,
    'elevated-emphasis': 0.973,
    paper: 0.993,
  },
  dark: {
    sunken: 0.185,
    base: 0.215,
    'base-emphasis': 0.235,
    elevated: 0.265,
    'elevated-emphasis': 0.305,
    paper: 0.215,
  },
} as const;
/** Yerleşik temaların zemin açıklığı (light.theme.ts / dark.theme.ts). */
const DEFAULT_BACKGROUND_L = { light: 0.991, dark: 0.178 } as const;

/** Yerleşik temalardaki kehribar/vurgu ayarları; özel temalar da aynı karakteri korur. */
const BUILT_IN_TWEAKS: Record<'light' | 'dark', ThemeInput['tweaks']> = {
  light: {
    amber: { darkForeground: true, steps: { 9: { l: 0.03 }, 10: { l: 0.02 }, 11: { l: -0.02 } } },
    accent: { steps: { 9: { l: -0.08 }, 10: { l: -0.06 }, 11: { l: -0.04 } } },
  },
  dark: {
    amber: { darkForeground: true, steps: { 9: { l: 0.05 }, 10: { l: 0.04 }, 11: { l: -0.01 } } },
    accent: { steps: { 9: { l: -0.08 }, 10: { l: -0.06 }, 11: { l: -0.04 } } },
  },
};

function hueOf(hex: string | undefined): number | undefined {
  const parsed = hex ? parseColor(hex) : null;
  return parsed ? rgbToOklch(parsed).h : undefined;
}

/** Özel temayı `defineTheme` girdisine çevirir (yerleşik temalarla aynı üreteç). */
export function customThemeToThemeInput(theme: CustomTheme): ThemeInput {
  const background = rgbToOklch(parseColor(theme.palette.background)!);
  const accent = rgbToOklch(parseColor(theme.palette.accent)!);
  const polarity = theme.polarity;
  const shift = background.l - DEFAULT_BACKGROUND_L[polarity];
  const surfaceLightness = Object.fromEntries(
    Object.entries(DEFAULT_SURFACE_L[polarity]).map(([scope, l]) => [
      scope,
      Math.min(0.995, Math.max(0.04, l + shift)),
    ])
  );
  const hues: NonNullable<ThemeInput['hues']> = {};
  const green = hueOf(theme.palette.success);
  const red = hueOf(theme.palette.danger);
  const amber = hueOf(theme.palette.warning);
  const blue = hueOf(theme.palette.info);
  if (green !== undefined) hues.green = green;
  if (red !== undefined) hues.red = red;
  if (amber !== undefined) hues.amber = amber;
  if (blue !== undefined) hues.blue = blue;
  return {
    id: `custom-${theme.id}`,
    label: theme.name,
    polarity,
    accent: { hue: accent.h, chroma: Math.max(0.02, Math.min(0.3, accent.c)) },
    // Neredeyse gri zeminlerde ton anlamsızdır; doygunluk sınırlanır ki yüzeyler renkli olmasın.
    neutral: { hue: background.h, chroma: Math.min(0.05, background.c) },
    hues,
    contrast: theme.contrast,
    chroma: theme.vividness,
    background: { lightness: Math.min(0.995, Math.max(0.04, background.l)) },
    surfaceLightness,
    gamut: 'p3',
    tweaks: BUILT_IN_TWEAKS[polarity],
    syntax: { generate: true },
  };
}

/** Uygulamanın (index.css) önekli olmayan ham ölçekleri → `--em-*` ölçek adı. */
const APP_SCALE_ALIASES: ReadonlyArray<[app: string, em: string]> = [
  ['neutral', 'neutral'],
  ['jade', 'accent'],
  ['green', 'green'],
  ['red', 'red'],
  ['amber', 'amber'],
  ['yellow', 'amber'],
  ['blue', 'blue'],
  ['cyan', 'blue'],
  ['orange', 'orange'],
  ['purple', 'purple'],
  ['violet', 'purple'],
];

/** index.css'te sabit renk olarak tanımlı anlamsal değişkenler → üretilen `--em-*` karşılığı. */
const APP_SEMANTIC_ALIASES: ReadonlyArray<[app: string, em: string]> = [
  ['--background', '--em-background'],
  ['--background-1', '--em-neutral-2'],
  ['--background-2', '--em-neutral-3'],
  ['--background-3', '--em-neutral-4'],
  ['--background-secondary-3', '--em-neutral-6'],
  ['--background-tertiary-2', '--em-neutral-5'],
  ['--background-tertiary-3', '--em-neutral-6'],
  ['--background-destructive-1', '--em-surface-destructive-hover'],
  ['--foreground-inverse', '--em-foreground-inverse'],
  ['--foreground-destructive-muted', '--em-foreground-destructive-muted'],
  ['--selection', '--em-selection'],
  ['--selection-foreground', '--em-selection-foreground'],
  ['--status-in-progress', '--em-status-in-progress'],
  ['--status-in-review', '--em-status-in-review'],
  ['--status-done', '--em-status-done'],
  ['--status-todo', '--em-status-todo'],
  ['--status-cancelled', '--em-status-cancelled'],
  ['--foreground-success', '--em-foreground-success'],
  ['--background-success', '--em-background-success'],
  ['--background-success-hover', '--em-background-success-hover'],
  ['--border-success', '--em-border-success'],
];

export type ContrastAdjustment = {
  token: string;
  /** Düzeltmeden önceki kontrast oranı. */
  before: number;
  after: number;
  required: number;
};

export type DerivedTheme = {
  /** Kök (tema sınıfı) üzerinde ayarlanacak tüm CSS değişkenleri. */
  vars: Record<string, string>;
  /** Kontrast korumasının yaptığı düzeltmeler (düzenleyicide uyarı olarak gösterilir). */
  adjustments: ContrastAdjustment[];
};

function rgbOf(value: string | undefined): Rgb | null {
  const parsed = value ? parseColor(value) : null;
  return parsed ? { r: parsed.r, g: parsed.g, b: parsed.b } : null;
}

/**
 * Kontrast koruması (T3'teki gibi): metin, soluk metin ve birincil düğme yazısı zemine göre
 * en az eşik kadar okunur değilse renk, tonu korunarak açıklık ekseninde kaydırılır.
 */
function guardContrast(vars: Record<string, string>, adjustments: ContrastAdjustment[]): void {
  const background = rgbOf(vars['--em-background']);
  if (!background) return;
  const ensure = (tokens: string[], surface: Rgb, required: number) => {
    const color = rgbOf(vars[tokens[0]!]);
    if (!color) return;
    const before = contrastRatio(color, surface);
    if (before >= required) return;
    // Hex'e yuvarlama oranı biraz düşürebilir; küçük bir pay bırakılır.
    const hex = toHex(readableColorOn(color, surface, required + 0.05));
    for (const token of tokens) vars[token] = hex;
    adjustments.push({
      token: tokens[0]!,
      before,
      after: contrastRatio(rgbOf(hex)!, surface),
      required,
    });
  };
  ensure(['--em-foreground', '--foreground'], background, TEXT_MIN_CONTRAST);
  ensure(['--em-foreground-muted', '--foreground-muted'], background, MUTED_MIN_CONTRAST);
  const button = rgbOf(vars['--em-primary-button-background']);
  if (button) {
    ensure(['--em-primary-button-foreground'], button, TEXT_MIN_CONTRAST);
  }
}

/** Paletten tam token kümesini türetir ve kontrast korumasını uygular. */
export function deriveThemeVars(theme: CustomTheme): DerivedTheme {
  const resolved = defineTheme(customThemeToThemeInput(theme));
  const vars: Record<string, string> = { ...resolved.cssVars };
  for (const [app, em] of APP_SCALE_ALIASES) {
    for (let step = 1; step <= 12; step++) {
      const value = vars[`--em-${em}-${step}`];
      if (value) vars[`--${app}-${step}`] = value;
    }
  }
  for (const [app, em] of APP_SEMANTIC_ALIASES) {
    const value = vars[em];
    if (value) vars[app] = value;
  }
  if (theme.palette.foreground) {
    vars['--em-foreground'] = theme.palette.foreground;
    vars['--foreground'] = theme.palette.foreground;
  } else {
    vars['--foreground'] = vars['--em-foreground'] ?? vars['--em-neutral-12'] ?? '';
  }
  vars['--foreground-muted'] = vars['--em-foreground-muted'] ?? vars['--em-neutral-11'] ?? '';
  const adjustments: ContrastAdjustment[] = [];
  guardContrast(vars, adjustments);
  return { vars, adjustments };
}

/** Özel temanın CSS'i: tema sınıfına (`.emlight`/`.emdark`) katmansız kural olarak yazılır. */
export function themeStylesheet(theme: CustomTheme, derived = deriveThemeVars(theme)): string {
  const selector = theme.polarity === 'light' ? '.emlight' : '.emdark';
  const body = Object.entries(derived.vars)
    .filter(([, value]) => value.length > 0)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return `${selector} {\n  color-scheme: ${theme.polarity};\n${body}\n}\n`;
}

// ── İçe/dışa aktarma ──────────────────────────────────────────────────────────

export type CustomThemeFile = {
  version: typeof CUSTOM_THEME_FILE_VERSION;
  kind: 'orkestra-theme';
  id: string;
  name: string;
  polarity: 'light' | 'dark';
  palette: CustomThemePalette;
  contrast: 'normal' | 'high';
  vividness: number;
};

export function serializeThemeFile(theme: CustomTheme): string {
  const file: CustomThemeFile = {
    version: CUSTOM_THEME_FILE_VERSION,
    kind: 'orkestra-theme',
    id: theme.id,
    name: theme.name,
    polarity: theme.polarity,
    palette: theme.palette,
    contrast: theme.contrast,
    vividness: theme.vividness,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export class ThemeImportError extends Error {}

/** Orkestra tema dosyasını doğrular; kimlik çakışırsa yeni kimlik üretir. */
export function parseThemeFile(
  value: unknown,
  taken: ReadonlySet<string> = new Set()
): CustomTheme {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ThemeImportError('Theme files must contain a JSON object.');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== CUSTOM_THEME_FILE_VERSION) {
    throw new ThemeImportError('Unsupported theme file version.');
  }
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const requestedId = typeof record.id === 'string' ? record.id : themeIdFromName(name);
  const id =
    taken.has(requestedId) || RESERVED_THEME_IDS.has(requestedId)
      ? themeIdFromName(name || requestedId, taken)
      : requestedId;
  const parsed = customThemeSchema.safeParse({ ...record, id, name });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ThemeImportError(
      `That theme file is not valid${issue ? `: ${issue.path.join('.') || 'file'} — ${issue.message}` : '.'}`
    );
  }
  return parsed.data;
}
