// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/shared/src/themeCss.ts,
// apps/web/src/themeCss.ts
//
// Özel CSS güvenliği: CSS dosya yükleyemez (@import, image-set(), src() ve data:/#id dışındaki
// url() atılır) — içe aktarılan bir temanın ekrandakileri başka bir siteye sızdırmasını önler.
// Ayrıca kullanıcı CSS'i `@scope` ile sarılır; `data-appearance-safe-zone` taşıyan öğeler (özel
// CSS ayar kartı, onay şeridi) kapsamın alt sınırıdır, yani kullanıcı kuralları onlara ulaşamaz.

export const CUSTOM_CSS_MAX_LENGTH = 100_000;
export const SAFE_ZONE_ATTRIBUTE = 'data-appearance-safe-zone';

const FETCHES_BY_STRING = /image-set\(|\bsrc\(/i;
// Yalnızca CSS boşluğu önce gelebilir. \s U+00A0'ı da eşler; bu adresi göreli yapar.
const URL_NOT_LOCAL = /url\((?![ \t\n\f\r]*["']?(?:data:|#))/i;
const ESCAPE = String.raw`\\(?:(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{1,5}(?![0-9a-fA-F]))(?:\r\n|[\n\r\f])?|\r\n|[^0-9a-fA-F])`;
const STRING = String.raw`"(?:${ESCAPE}|[^"\\\n\r\f])*"|'(?:${ESCAPE}|[^'\\\n\r\f])*'`;
const URL_OR_STRING = String.raw`url\((?![ \t\n\f\r]*["'])([^)]*)|url\([ \t\n\f\r]*(${STRING})|${STRING}|${ESCAPE}`;
const CSS_TOKENS = new RegExp(String.raw`\/\*[\s\S]*?\*\/|${URL_OR_STRING}`, 'gi');

/**
 * Dizgi ve yorumları atılmış kod; yükleme yapabilecek yerlerde `url(` korunur. Bildirim
 * değerinde kaçış (escape) içeren bir yorum ya da tırnaklı url() olduğu gibi kalır.
 */
function withoutStrings(code: string, stylesheet: boolean): string {
  return code.replace(CSS_TOKENS, (token, address?: string, urlString?: string) => {
    const url = stylesheet ? (address ?? urlString) : urlString;
    if (url !== undefined) {
      if (!stylesheet && url.includes('\\')) return token;
      return /^[ \t\n\f\r]*["']?(?:data:|#)/i.test(url) ? '' : 'url(';
    }
    if (token.startsWith('/*')) {
      if (stylesheet) return '';
      return token.includes('\\') ? token : ' ';
    }
    return /^["']/.test(token) ? '' : token;
  });
}

function fetchesOutsideStrings(code: string): boolean {
  return FETCHES_BY_STRING.test(code) || URL_NOT_LOCAL.test(code);
}

/** Tek bir bildirim değeri uzak bir dosya yükleyebilir mi? (Kaçışlarla kandırmaya kapalı.) */
export function cssValueFetches(value: string): boolean {
  const code = withoutStrings(value, false);
  return code.includes('\\') || fetchesOutsideStrings(code);
}

/** Erken geri bildirim için metin denetimi; asıl koruma tarayıcıdaki CSSOM geçişidir. */
export function cssLoadsRemoteFiles(css: string): boolean {
  const code = withoutStrings(css, true);
  return /@import/i.test(code) || fetchesOutsideStrings(code);
}

/** Dizgi ve yorumları aynı uzunlukta maskeler (konumlar korunur). */
function maskStringsAndComments(css: string): string {
  return css.replace(new RegExp(String.raw`\/\*[\s\S]*?\*\/|${STRING}`, 'g'), (token) =>
    token.startsWith('/*')
      ? ' '.repeat(token.length)
      : `"${'x'.repeat(Math.max(0, token.length - 2))}"`
  );
}

export type SanitizedCss = { css: string; removed: number };

/**
 * Metin düzeyinde temizlik: `@import` kurallarını ve dosya yükleyebilen bildirimleri atar.
 * Tarayıcıda ayrıca CSSOM üzerinden ikinci bir geçiş yapılır (bkz. browser/custom-css-sheet).
 */
export function sanitizeCustomCss(input: string): SanitizedCss {
  let css = input.slice(0, CUSTOM_CSS_MAX_LENGTH);
  let removed = 0;
  // </style> gibi bir kapanış ancak <style> içine yazılırsa önemlidir; yine de kaldır.
  css = css.replace(/<\/?style/gi, () => {
    removed++;
    return '';
  });
  const cut = (ranges: Array<[number, number]>) => {
    for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
      css = css.slice(0, start) + css.slice(end);
      removed++;
    }
  };
  // @import / @namespace url(...) — maskelenmiş metinde bulunur, özgün metinden kesilir.
  {
    const masked = maskStringsAndComments(css);
    const ranges: Array<[number, number]> = [];
    for (const match of masked.matchAll(/@import\b[^;{}]*(?:;|$)/gi)) {
      ranges.push([match.index!, match.index! + match[0].length]);
    }
    cut(ranges);
  }
  // Bildirimler: `ad: değer;` — değer dosya yükleyebiliyorsa bildirim atılır.
  {
    const masked = maskStringsAndComments(css);
    const ranges: Array<[number, number]> = [];
    for (const match of masked.matchAll(/([-\w]+)\s*:([^;{}]*)(;|(?=\}))/g)) {
      const valueStart = match.index! + match[0].indexOf(':') + 1;
      const value = css.slice(valueStart, valueStart + match[2]!.length);
      if (cssValueFetches(value)) ranges.push([match.index!, match.index! + match[0].length]);
    }
    cut(ranges);
  }
  return { css, removed };
}

/**
 * Kullanıcı CSS'ini güvenli bölgenin dışında kalacak şekilde sarar. `@scope (:root) to (…)`
 * alt sınırı dışlayıcıdır: güvenli bölge öğeleri ve altları kuralların kapsamına girmez.
 */
export function scopeCustomCss(css: string): string {
  if (css.trim().length === 0) return '';
  return `@scope (:root) to ([${SAFE_ZONE_ATTRIBUTE}]) {\n${css}\n}\n`;
}

/** Kaydedilen CSS'in özeti; onaylanmış CSS ile karşılaştırmak için (FNV-1a, 32 bit). */
export function hashCustomCss(css: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < css.length; i++) {
    hash ^= css.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Özel CSS'in dayanabileceği kararlı seçiciler (diğer sınıf adları sürümler arasında değişir). */
export const CUSTOM_CSS_HOOKS: ReadonlyArray<{ selector: string; styles: string }> = [
  { selector: '.emlight / .emdark', styles: 'root class for the light or dark appearance' },
  { selector: '[data-chat-surface]', styles: 'conversation panel, behind the transcript' },
  { selector: '[data-chat-scroll]', styles: 'transcript scroller' },
  { selector: '[data-slot="button"]', styles: 'button' },
  { selector: '[data-slot="input-group"]', styles: 'text input group' },
  { selector: '[data-slot="textarea"]', styles: 'multi-line text input' },
  { selector: '[data-slot="switch"]', styles: 'switch' },
  { selector: '[data-slot="select-trigger"]', styles: 'select' },
  { selector: '[data-slot="tabs-list"]', styles: 'tab strip' },
  { selector: '[data-slot="dropdown-menu-content"]', styles: 'menu' },
  { selector: '[data-slot="dropdown-menu-item"]', styles: 'menu item' },
  { selector: '[data-slot="popover-content"]', styles: 'popover' },
  { selector: '[data-slot="tooltip-content"]', styles: 'tooltip' },
  { selector: 'svg.lucide', styles: 'icons (stroke-width, stroke-linecap)' },
];

/** Temanın sürdüğü, özel CSS'te güvenle kullanılabilecek değişkenler. */
export const CUSTOM_CSS_VARIABLES: ReadonlyArray<{ name: string; meaning: string }> = [
  { name: '--background', meaning: 'app background' },
  { name: '--foreground', meaning: 'main text' },
  { name: '--foreground-muted', meaning: 'secondary text' },
  { name: '--border', meaning: 'borders' },
  { name: '--em-accent-9', meaning: 'accent fill' },
  { name: '--em-surface-paper', meaning: 'editor and chat surface' },
  { name: '--chat-bg', meaning: 'transcript background' },
  { name: '--chat-bubble-user', meaning: 'user message bubble' },
  { name: '--chat-code-bg', meaning: 'code block background' },
  { name: '--radius', meaning: 'corner radius' },
];

/** "Bir ajana sor" yönergesi: kullanıcı bunu kopyalayıp bir sohbete yapıştırır. */
export function appearanceAgentGuide(): string {
  return [
    'Help me restyle the Orkestra desktop app. Produce an Orkestra theme file I can import from',
    'Settings → Interface → Custom themes → Import. Reply with the JSON only, in a code block.',
    '',
    'Theme file format:',
    '{ "version": 1, "kind": "orkestra-theme", "id": "my-theme", "name": "My theme",',
    '  "polarity": "dark" | "light", "contrast": "normal" | "high", "vividness": 1.15,',
    '  "palette": { "background": "#hex", "accent": "#hex", "foreground"?: "#hex",',
    '               "success"?: "#hex", "danger"?: "#hex", "warning"?: "#hex", "info"?: "#hex" } }',
    'The whole token set (surfaces, borders, text, syntax colors, terminal and editor) is derived',
    'from these base colors; text that would be unreadable is corrected automatically.',
    '',
    'If colors are not enough, also give me custom CSS for Settings → Interface → Custom CSS.',
    'Custom CSS cannot load files: no @import, no image-set(), url() only with data: or #id.',
    'Use `.emdark` or `.emlight` to target one appearance. If a rule has no effect, add !important.',
    'Stable selectors (other class names change between releases, do not use them):',
    ...CUSTOM_CSS_HOOKS.map((hook) => `- ${hook.selector}: ${hook.styles}`),
    'Theme variables:',
    ...CUSTOM_CSS_VARIABLES.map((variable) => `- ${variable.name}: ${variable.meaning}`),
    '',
    'For a background image use Settings → Interface → Background image instead of CSS.',
  ].join('\n');
}
