import { describe, expect, it } from 'vitest';
import { ONE_DARK_VSCODE_THEME } from './__fixtures__/one-dark-vscode-theme';
import {
  backgroundStylesheet,
  MAX_BACKGROUND_BLUR_PX,
  MIN_BACKGROUND_DIM,
  normalizeBackground,
} from './background';
import { contrastRatio, parseColor, readableColorOn } from './color';
import {
  cssLoadsRemoteFiles,
  cssValueFetches,
  hashCustomCss,
  sanitizeCustomCss,
  scopeCustomCss,
  SAFE_ZONE_ATTRIBUTE,
} from './custom-css';
import {
  BUILT_IN_THEME_SEEDS,
  createThemeFrom,
  customThemeSchema,
  customThemeToThemeInput,
  deriveThemeVars,
  duplicateTheme,
  parseThemeFile,
  serializeThemeFile,
  TEXT_MIN_CONTRAST,
  themeIdFromName,
  themeStylesheet,
  ThemeImportError,
  type CustomTheme,
} from './custom-theme';
import { parseThemeImport } from './theme-import';
import { humanizeThemeName, isVsCodeThemeFile, parseJsonc, parseVsCodeTheme } from './vscode-theme';

const fixture = ONE_DARK_VSCODE_THEME;

function rgb(value: string) {
  const parsed = parseColor(value);
  if (!parsed) throw new Error(`not a color: ${value}`);
  return parsed;
}

function theme(overrides: Partial<CustomTheme> = {}): CustomTheme {
  return customThemeSchema.parse({
    id: 'ocean',
    name: 'Ocean',
    polarity: 'dark',
    palette: { background: '#0b1d2a', accent: '#2aa7d6' },
    ...overrides,
  });
}

describe('palette → token derivation', () => {
  it('derives the full built-in token set from a few base colours', () => {
    const { vars } = deriveThemeVars(theme());
    // Generated @orkestra/theme tokens …
    for (const token of [
      '--em-neutral-1',
      '--em-accent-9',
      '--em-surface-paper',
      '--em-background',
      '--em-foreground',
      '--em-syntax-keyword',
      '--em-shadow-md',
    ]) {
      expect(vars[token], token).toBeTruthy();
    }
    // … and the app's own raw scales and literal semantic tokens.
    for (let step = 1; step <= 12; step++) {
      expect(vars[`--neutral-${step}`]).toBe(vars[`--em-neutral-${step}`]);
      expect(vars[`--jade-${step}`]).toBe(vars[`--em-accent-${step}`]);
    }
    expect(vars['--background']).toBe(vars['--em-background']);
    expect(vars['--selection']).toBe(vars['--em-selection']);
    expect(Object.keys(vars).length).toBeGreaterThan(400);
  });

  it('maps base colours onto defineTheme seeds', () => {
    const input = customThemeToThemeInput(
      theme({ palette: { background: '#0b1d2a', accent: '#2aa7d6', danger: '#ff0000' } })
    );
    expect(input.polarity).toBe('dark');
    expect(input.background?.lightness).toBeLessThan(0.3);
    expect(input.neutral?.chroma).toBeLessThanOrEqual(0.05);
    expect(
      typeof input.accent === 'object' && 'hue' in input.accent && input.accent.hue
    ).toBeCloseTo(231, -1);
    expect(input.hues?.red).toBeCloseTo(29, -1);
    expect(input.hues?.green).toBeUndefined();
  });

  it('follows the background lightness: a darker canvas yields a darker background token', () => {
    const dim = rgb(
      deriveThemeVars(theme({ palette: { background: '#050505', accent: '#2aa7d6' } })).vars[
        '--em-background'
      ]!
    );
    const lifted = rgb(
      deriveThemeVars(theme({ palette: { background: '#2a2a2a', accent: '#2aa7d6' } })).vars[
        '--em-background'
      ]!
    );
    expect(dim.r + dim.g + dim.b).toBeLessThan(lifted.r + lifted.g + lifted.b);
  });

  it('every built-in seed derives a readable theme', () => {
    for (const seed of BUILT_IN_THEME_SEEDS) {
      const derived = deriveThemeVars(createThemeFrom(seed, `${seed.name} mine`, new Set()));
      const ratio = contrastRatio(
        rgb(derived.vars['--foreground']!),
        rgb(derived.vars['--em-background']!)
      );
      expect(ratio, seed.id).toBeGreaterThanOrEqual(TEXT_MIN_CONTRAST);
    }
  });

  it('writes an unlayered rule on the polarity class', () => {
    const css = themeStylesheet(
      theme({ polarity: 'light', palette: { background: '#fafafa', accent: '#0a7' } })
    );
    expect(css.startsWith('.emlight {')).toBe(true);
    expect(css).toContain('color-scheme: light;');
    expect(css).toContain('--em-accent-9:');
    expect(css).not.toContain('@layer');
  });
});

describe('contrast guard', () => {
  it('corrects an unreadable foreground and reports it', () => {
    const derived = deriveThemeVars(
      theme({ palette: { background: '#222222', foreground: '#2f2f2f', accent: '#ffcc00' } })
    );
    const fg = rgb(derived.vars['--foreground']!);
    const bg = rgb(derived.vars['--em-background']!);
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(TEXT_MIN_CONTRAST);
    expect(derived.vars['--em-foreground']).toBe(derived.vars['--foreground']);
    const adjustment = derived.adjustments.find((a) => a.token === '--em-foreground');
    expect(adjustment?.before).toBeLessThan(TEXT_MIN_CONTRAST);
    expect(adjustment?.after).toBeGreaterThanOrEqual(TEXT_MIN_CONTRAST);
  });

  it('leaves a readable foreground untouched', () => {
    const derived = deriveThemeVars(
      theme({ palette: { background: '#101010', foreground: '#e0e0e0', accent: '#3bb387' } })
    );
    expect(derived.vars['--foreground']).toBe('#e0e0e0');
    expect(derived.adjustments.find((a) => a.token === '--em-foreground')).toBeUndefined();
  });

  it('readableColorOn keeps the hue and reaches the target', () => {
    const fixed = readableColorOn(rgb('#334455'), rgb('#223344'), 4.5);
    expect(contrastRatio(fixed, rgb('#223344'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('VS Code theme mapping (fixture)', () => {
  it('detects and maps a JSONC VS Code theme', () => {
    const value = parseJsonc(fixture);
    expect(isVsCodeThemeFile(value)).toBe(true);
    const mapped = parseVsCodeTheme(value);
    expect(mapped.name).toBe('One Dark Pro');
    expect(mapped.id).toBe('one-dark-pro');
    expect(mapped.polarity).toBe('dark');
    expect(mapped.palette.background).toBe('#282c34');
    // focusBorder and button.background barely differ from the canvas → textLink wins.
    expect(mapped.palette.accent).toBe('#61afef');
    expect(mapped.palette.foreground).toBe('#abb2bf');
    expect(mapped.palette.danger).toBe('#e06c75');
    expect(mapped.palette.warning).toBe('#d19a66');
    expect(mapped.palette.success).toBe('#98c379');
    // Translucent colours are flattened onto the canvas.
    expect(mapped.palette.info).not.toBe('#61afef');
  });

  it('rejects a theme without editor.background', () => {
    expect(() => parseVsCodeTheme({ colors: { 'button.background': '#fff' } })).toThrow(
      ThemeImportError
    );
  });

  it('infers polarity from the canvas when type is missing and fixes unreadable text', () => {
    const mapped = parseVsCodeTheme({
      colors: { 'editor.background': '#fdfdfd', 'editor.foreground': '#eeeeee' },
    });
    expect(mapped.polarity).toBe('light');
    expect(contrastRatio(rgb(mapped.palette.foreground!), rgb('#fdfdfd'))).toBeGreaterThanOrEqual(
      4.5
    );
  });

  it('humanizes slug names', () => {
    expect(humanizeThemeName('github-dark_dimmed')).toBe('Github Dark Dimmed');
    expect(humanizeThemeName('Monokai Pro')).toBe('Monokai Pro');
  });
});

describe('import / export round trip', () => {
  it('serializes and parses back to the same theme', () => {
    const original = theme({
      palette: { background: '#0b1d2a', accent: '#2aa7d6', foreground: '#dde6ee', info: '#3399ff' },
      contrast: 'high',
      vividness: 0.8,
    });
    const text = serializeThemeFile(original);
    expect(parseThemeImport(text)).toEqual(original);
  });

  it('renames the id on collision and rejects invalid files', () => {
    const text = serializeThemeFile(theme());
    expect(parseThemeImport(text, new Set(['ocean'])).id).toBe('ocean-2');
    expect(() => parseThemeImport('{"version":1,"name":"x"}')).toThrow(ThemeImportError);
    expect(() => parseThemeImport('not json')).toThrow(ThemeImportError);
    expect(() => parseThemeFile({ version: 99 })).toThrow(ThemeImportError);
  });

  it('routes VS Code files through the VS Code mapper', () => {
    expect(parseThemeImport(fixture).palette.background).toBe('#282c34');
  });

  it('creates, duplicates and names themes with unique ids', () => {
    const created = createThemeFrom(BUILT_IN_THEME_SEEDS[1]!, 'My Dark', new Set());
    expect(created.id).toBe('my-dark');
    const copy = duplicateTheme(created, new Set([created.id]));
    expect(copy.name).toBe('My Dark copy');
    expect(copy.id).toBe('my-dark-copy');
    expect(copy.palette).toEqual(created.palette);
    expect(themeIdFromName('Dark')).toBe('dark-custom');
    expect(themeIdFromName('Şık Tema', new Set(['sik-tema']))).toBe('sik-tema-2');
  });
});

describe('custom CSS sanitising and scoping', () => {
  it('detects values that fetch', () => {
    expect(cssValueFetches('url(https://evil.example/x.png)')).toBe(true);
    expect(cssValueFetches('url("https://evil.example/x.png")')).toBe(true);
    expect(cssValueFetches('image-set("a.png" 1x)')).toBe(true);
    expect(cssValueFetches('u\\72l(https://evil)')).toBe(true);
    expect(cssValueFetches('url(data:image/png;base64,AAAA)')).toBe(false);
    expect(cssValueFetches('url(#gradient)')).toBe(false);
    expect(cssValueFetches('linear-gradient(red, blue)')).toBe(false);
    expect(cssValueFetches('"url(https://x)"')).toBe(false);
  });

  it('removes @import and fetching declarations but keeps the rest', () => {
    const input = [
      '@import url("https://evil.example/a.css");',
      '[data-chat-surface] { background: url(https://evil.example/spy?x=1); color: red; }',
      '.emdark [data-slot="button"] { border-radius: 2px; background-image: url(data:image/png;base64,AA); }',
      'a::after { content: "url(https://not-a-fetch)"; }',
    ].join('\n');
    const { css, removed } = sanitizeCustomCss(input);
    expect(removed).toBe(2);
    expect(css).not.toContain('@import');
    expect(css).not.toContain('evil.example');
    expect(css).toContain('color: red;');
    expect(css).toContain('border-radius: 2px;');
    expect(css).toContain('url(data:image/png;base64,AA)');
    expect(css).toContain('content: "url(https://not-a-fetch)"');
    expect(cssLoadsRemoteFiles(css)).toBe(false);
    expect(cssLoadsRemoteFiles(input)).toBe(true);
  });

  it('strips style-tag breakouts', () => {
    expect(sanitizeCustomCss('a{color:red}</style><script>x</script>').css).not.toContain(
      '</style'
    );
  });

  it('scopes user CSS away from the safe zone', () => {
    const scoped = scopeCustomCss('body { display: none; }');
    expect(scoped).toBe(
      `@scope (:root) to ([${SAFE_ZONE_ATTRIBUTE}]) {\nbody { display: none; }\n}\n`
    );
    expect(scopeCustomCss('   ')).toBe('');
  });

  it('hashes deterministically', () => {
    expect(hashCustomCss('a{}')).toBe(hashCustomCss('a{}'));
    expect(hashCustomCss('a{}')).not.toBe(hashCustomCss('b{}'));
  });
});

describe('background image', () => {
  it('clamps values and keeps a minimum scrim over the image', () => {
    const normalized = normalizeBackground({
      enabled: true,
      fileName: 'background-abcdef12.png',
      opacity: 3,
      blur: 999,
      dim: 0,
    });
    expect(normalized).toEqual({
      enabled: true,
      fileName: 'background-abcdef12.png',
      opacity: 1,
      blur: MAX_BACKGROUND_BLUR_PX,
      dim: MIN_BACKGROUND_DIM,
    });
  });

  it('is disabled without an image and emits CSS only when enabled', () => {
    expect(
      backgroundStylesheet({ enabled: true, fileName: null, opacity: 1, blur: 0, dim: 0.8 })
    ).toBe('');
    const css = backgroundStylesheet({
      enabled: true,
      fileName: 'background-abcdef12.png',
      opacity: 0.5,
      blur: 6,
      dim: 0.8,
    });
    expect(css).toContain('var(--em-surface-paper) 80%');
    expect(css).toContain('filter: blur(6px)');
    expect(css).toContain('opacity: 0.5');
  });
});
