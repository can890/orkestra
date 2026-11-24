// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src/vscodeThemeImport.ts
//
// VS Code renk teması (.json / JSONC) → Orkestra özel teması. T3'teki gibi zemin
// `editor.background`'dan, vurgu zeminden ayrışan ilk aday anahtardan (focusBorder, button…),
// metin ve durum renkleri okunabilirlik denetimiyle seçilir. Orkestra'da tüm token kümesi bu
// birkaç taban renkten türetildiği için yalnızca taban renkler eşlenir.

import {
  contrastRatio,
  flattenOver,
  parseColor,
  readableColorOn,
  relativeLuminance,
  toHex,
  type Rgb,
  type Rgba,
} from './color';
import {
  CUSTOM_THEME_NAME_MAX,
  customThemeSchema,
  ThemeImportError,
  themeIdFromName,
  type CustomTheme,
  type CustomThemePalette,
} from './custom-theme';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSONC: yorumları ve sondaki virgülleri (dizgilerin dışında) temizleyip ayrıştırır. */
export function parseJsonc(source: string): unknown {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Sondaki virgüller: `,` ardından yalnızca boşluk ve `}`/`]`.
  const withoutTrailingCommas = out.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(withoutTrailingCommas);
  } catch {
    throw new ThemeImportError('That theme file is not valid JSON.');
  }
}

/** Orkestra dosyası değil, VS Code teması mı? */
export function isVsCodeThemeFile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'orkestra-theme') return false;
  const hasWorkbenchColors =
    isRecord(value.colors) && Object.keys(value.colors).some((key) => key.includes('.'));
  return hasWorkbenchColors || Array.isArray(value.tokenColors);
}

export function humanizeThemeName(raw: string): string {
  const trimmed = raw.trim();
  if (/\s/.test(trimmed) || !/[-_.]/.test(trimmed)) return trimmed;
  return trimmed
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function resolveName(value: Record<string, unknown>): string {
  for (const candidate of [value.displayName, value.name, value.label]) {
    if (typeof candidate !== 'string') continue;
    const humanized = humanizeThemeName(candidate);
    if (humanized.length > 0) return humanized.slice(0, CUSTOM_THEME_NAME_MAX);
  }
  return 'VS Code theme';
}

const FALLBACK_ACCENT = { light: '#008753', dark: '#3bb387' } as const;

/** Token renklerinden (tokenColors) bir kapsamın ön plan rengini bulur. */
function tokenColor(value: Record<string, unknown>, scopes: readonly string[]): Rgba | null {
  if (!Array.isArray(value.tokenColors)) return null;
  for (const entry of value.tokenColors) {
    if (!isRecord(entry) || !isRecord(entry.settings)) continue;
    const scope = entry.scope;
    const list = typeof scope === 'string' ? scope.split(',').map((s) => s.trim()) : scope;
    if (!Array.isArray(list)) continue;
    if (list.some((s) => typeof s === 'string' && scopes.some((wanted) => s === wanted))) {
      const parsed = parseColor(entry.settings.foreground);
      if (parsed) return parsed;
    }
  }
  return null;
}

export function parseVsCodeTheme(
  value: unknown,
  taken: ReadonlySet<string> = new Set()
): CustomTheme {
  if (!isRecord(value)) throw new ThemeImportError('Theme files must contain a JSON object.');
  const colors = isRecord(value.colors) ? value.colors : {};
  const pick = (...keys: readonly string[]): Rgba | null => {
    for (const key of keys) {
      const parsed = parseColor(colors[key]);
      if (parsed) return parsed;
    }
    return null;
  };
  const canvasColor = pick('editor.background', 'editorPane.background');
  if (!canvasColor) {
    throw new ThemeImportError(
      'That VS Code theme has no "editor.background" color, so there is nothing to build a palette from.'
    );
  }
  const canvas: Rgb = { r: canvasColor.r, g: canvasColor.g, b: canvasColor.b };
  const type = typeof value.type === 'string' ? value.type.toLowerCase() : null;
  const polarity: 'light' | 'dark' =
    type === 'light' || type === 'hc-light'
      ? 'light'
      : type === 'dark' || type === 'hc-black'
        ? 'dark'
        : relativeLuminance(canvas) < 0.179
          ? 'dark'
          : 'light';
  const standsApart = (first: Rgb, second: Rgb) => contrastRatio(first, second) >= 1.1;
  const raised = pick('editorWidget.background', 'dropdown.background');
  const raisedRgb = raised ? flattenOver(raised, canvas) : null;

  let accent: Rgb | null = null;
  for (const key of [
    'focusBorder',
    'button.background',
    'textLink.foreground',
    'activityBarBadge.background',
    'progressBar.background',
    'badge.background',
  ]) {
    const candidate = parseColor(colors[key]);
    if (!candidate) continue;
    const solid = flattenOver(candidate, canvas);
    if (!standsApart(solid, canvas) || (raisedRgb && !standsApart(solid, raisedRgb))) continue;
    accent = solid;
    break;
  }
  const accentHex = accent ? toHex(accent) : FALLBACK_ACCENT[polarity];

  // Metin: belirtilen ön plan okunurluk eşiğini geçmiyorsa düzeltilir (T3'ün readableOn'u).
  const foregroundRaw = pick('editor.foreground', 'foreground');
  const foreground = foregroundRaw
    ? toHex(readableColorOn(flattenOver(foregroundRaw, canvas), canvas, 4.5))
    : undefined;

  // Durum renkleri: zeminden ayrışmayan bir renk tonsuzdur; o durumda varsayılana bırakılır.
  const status = (fallbackScopes: readonly string[], ...keys: readonly string[]) => {
    const specified = pick(...keys) ?? tokenColor(value, fallbackScopes);
    if (!specified) return undefined;
    const solid = flattenOver(specified, canvas);
    return standsApart(solid, canvas) ? toHex(solid) : undefined;
  };

  const palette: CustomThemePalette = {
    background: toHex(canvas),
    accent: accentHex,
    ...(foreground ? { foreground } : {}),
  };
  const success = status(
    ['markup.inserted', 'string'],
    'terminal.ansiGreen',
    'gitDecoration.addedResourceForeground',
    'editorGutter.addedBackground'
  );
  const danger = status(
    ['invalid', 'markup.deleted'],
    'editorError.foreground',
    'errorForeground',
    'terminal.ansiRed'
  );
  const warning = status(['markup.changed'], 'editorWarning.foreground', 'terminal.ansiYellow');
  const info = status(['entity.name.function'], 'editorInfo.foreground', 'terminal.ansiBlue');
  if (success) palette.success = success;
  if (danger) palette.danger = danger;
  if (warning) palette.warning = warning;
  if (info) palette.info = info;

  const name = resolveName(value);
  return customThemeSchema.parse({
    id: themeIdFromName(name, taken),
    name,
    polarity,
    palette,
    contrast: type === 'hc-black' || type === 'hc-light' ? 'high' : 'normal',
    vividness: 1.15,
  });
}
