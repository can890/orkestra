// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src/themePalette.ts,
// apps/web/src/vscodeThemeImport.ts (renk ayrıştırma, kontrast ve OKLCH yardımcıları)
//
// Bağımlılıksız renk matematiği: hex / rgb() / color(display-p3|srgb …) ayrıştırma, WCAG
// kontrast oranı ve OKLCH dönüşümleri. Özel temaların taban renklerinden ton/doygunluk/açıklık
// çıkarmak ve kontrast korumasını uygulamak için kullanılır.

export type Rgb = { r: number; g: number; b: number };
export type Rgba = Rgb & { a: number };
export type Oklch = { l: number; c: number; h: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function decodeGamma(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function encodeGamma(value: number): number {
  const clamped = clamp(value, 0, 1);
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function parseChannel(part: string, scale: number): number {
  return part.endsWith('%') ? (Number.parseFloat(part) / 100) * scale : Number.parseFloat(part);
}

function parseAlpha(part: string | undefined): number {
  if (part === undefined) return 1;
  const trimmed = part.trim();
  const value = trimmed.endsWith('%')
    ? Number.parseFloat(trimmed) / 100
    : Number.parseFloat(trimmed);
  return Number.isFinite(value) ? clamp(value, 0, 1) : 1;
}

function parseColorFunction(value: string): Rgba | null {
  const match = /^color\(\s*(display-p3|srgb)\s+([^)]+)\)$/i.exec(value);
  if (!match) return null;
  const space = match[1]!.toLowerCase();
  const [channelPart, alphaPart] = match[2]!.split('/');
  const channels = channelPart!
    .trim()
    .split(/\s+/)
    .map((part) => parseChannel(part, 1));
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) return null;
  const a = parseAlpha(alphaPart);
  const [red, green, blue] = channels as [number, number, number];
  if (space === 'srgb') return { r: red * 255, g: green * 255, b: blue * 255, a };
  // display-p3 → doğrusal → sRGB (gamut dışı kanallar kırpılır).
  const [lr, lg, lb] = [red, green, blue].map(decodeGamma) as [number, number, number];
  const srgb = [
    1.2249401762805 * lr - 0.2249401762805 * lg,
    -0.042056961239 * lr + 1.042056961239 * lg,
    -0.0196375547643 * lr - 0.0786360655012 * lg + 1.0982736202656 * lb,
  ].map((channel) => encodeGamma(channel) * 255) as [number, number, number];
  return { r: srgb[0], g: srgb[1], b: srgb[2], a };
}

function parseRgbFunction(value: string): Rgba | null {
  const match = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (!match) return null;
  const body = match[1]!.replace(/,/g, ' ').replace(/\s*\/\s*/, ' / ');
  const [channelPart, alphaPart] = body.split('/');
  const parts = channelPart!.trim().split(/\s+/);
  const alpha = alphaPart ?? (parts.length === 4 ? parts.pop() : undefined);
  if (parts.length !== 3) return null;
  const [r, g, b] = parts.map((part) => parseChannel(part, 255)) as [number, number, number];
  if (![r, g, b].every(Number.isFinite)) return null;
  return { r, g, b, a: parseAlpha(alpha) };
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()` ve `color(display-p3|srgb …)`. */
export function parseColor(value: unknown): Rgba | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.startsWith('color(')) return parseColorFunction(trimmed);
  if (/^rgba?\(/i.test(trimmed)) return parseRgbFunction(trimmed);
  const hex = trimmed.replace(/^#/, '');
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const expand = (part: string) =>
    part.length === 1 ? Number.parseInt(part + part, 16) : Number.parseInt(part, 16);
  if (hex.length <= 4) {
    return {
      r: expand(hex[0]!),
      g: expand(hex[1]!),
      b: expand(hex[2]!),
      a: hex.length === 4 ? expand(hex[3]!) / 255 : 1,
    };
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

export function toHex(color: Rgb): string {
  const channel = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** Geçerli bir rengi `#rrggbb` biçimine getirir; geçersizse null. */
export function normalizeHex(value: unknown): string | null {
  const parsed = parseColor(value);
  return parsed ? toHex(parsed) : null;
}

/** Yarı saydam rengi bir zeminin üstüne düzleştirir (VS Code katmanları için). */
export function flattenOver(color: Rgba, base: Rgb): Rgb {
  if (color.a >= 1) return { r: color.r, g: color.g, b: color.b };
  return {
    r: color.r * color.a + base.r * (1 - color.a),
    g: color.g * color.a + base.g * (1 - color.a),
    b: color.b * color.a + base.b * (1 - color.a),
  };
}

export function relativeLuminance(color: Rgb): number {
  const channel = (value: number) => decodeGamma(clamp(value, 0, 255) / 255);
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 2 kontrast oranı (1–21). */
export function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function rgbToOklch(color: Rgb): Oklch {
  const [r, g, b] = [color.r, color.g, color.b].map((v) => decodeGamma(clamp(v, 0, 255) / 255)) as [
    number,
    number,
    number,
  ];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.sqrt(A * A + B * B);
  const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

function oklchToRgbUnclamped({ l: L, c, h }: Oklch): Rgb {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr);
  const B = c * Math.sin(hr);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const [r, g, b] = lin.map((v) => encodeGamma(v) * 255) as [number, number, number];
  return { r, g, b };
}

export function oklchToRgb(color: Oklch): Rgb {
  // Gamut dışındaysa doygunluğu düşürerek sRGB içine sığdır.
  let c = color.c;
  for (let i = 0; i < 24; i++) {
    const hr = (color.h * Math.PI) / 180;
    const A = c * Math.cos(hr);
    const B = c * Math.sin(hr);
    const lms = [
      (color.l + 0.3963377774 * A + 0.2158037573 * B) ** 3,
      (color.l - 0.1055613458 * A - 0.0638541728 * B) ** 3,
      (color.l - 0.0894841775 * A - 1.291485548 * B) ** 3,
    ] as [number, number, number];
    const lin = [
      4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
      -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
      -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
    ];
    if (lin.every((v) => v >= -0.0005 && v <= 1.0005)) break;
    c *= 0.85;
  }
  return oklchToRgbUnclamped({ ...color, c });
}

/**
 * `color`ı `surface` üzerinde en az `minContrast` okunur olacak şekilde, tonunu koruyarak
 * OKLCH açıklığı boyunca kaydırır. Yetmezse siyah ya da beyaza düşer.
 */
export function readableColorOn(color: Rgb, surface: Rgb, minContrast: number): Rgb {
  if (contrastRatio(color, surface) >= minContrast) return color;
  const base = rgbToOklch(color);
  const surfaceIsDark = relativeLuminance(surface) < 0.179;
  const target = surfaceIsDark ? 1 : 0;
  let lo = base.l;
  let hi = target;
  let best: Rgb | null = null;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const candidate = oklchToRgb({ ...base, l: mid });
    if (contrastRatio(candidate, surface) >= minContrast) {
      best = candidate;
      hi = mid;
    } else {
      lo = mid;
    }
  }
  if (best) return best;
  return surfaceIsDark ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
}
