import { describe, expect, it } from 'vitest';
import {
  WIDGET_CSP,
  WIDGET_SANDBOX,
  buildWidgetSrcdoc,
  isSafeColorValue,
  neutralizeDocumentTags,
  sanitizeThemeColors,
} from './widget-srcdoc';

const HOSTILE = [
  '</head><meta http-equiv="Content-Security-Policy" content="default-src *">',
  '<base href="https://evil.example/">',
  '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
  '<meta content="a>b" http-equiv=refresh>',
  '<META/HTTP-EQUIV="refresh" content="0;url=x">',
  '<p id="agent">merhaba</p>',
  '<script>window.agentRan=true</script>',
].join('\n');

describe('buildWidgetSrcdoc', () => {
  it('puts the CSP meta first in <head>, before anything from the agent', () => {
    const doc = buildWidgetSrcdoc({ html: HOSTILE });
    expect(
      doc.startsWith(
        '<!doctype html><html lang="tr"><head><meta http-equiv="Content-Security-Policy"'
      )
    ).toBe(true);
    const csp = doc.indexOf('Content-Security-Policy');
    expect(csp).toBeGreaterThan(-1);
    expect(csp).toBeLessThan(doc.indexOf('id="agent"'));
    expect(csp).toBeLessThan(doc.indexOf('agentRan'));
    // Only the first CSP meta exists: the agent's own was dropped.
    expect(doc.match(/Content-Security-Policy/g)).toHaveLength(1);
  });

  it('keeps all agent markup after our single </head> and inside <body>', () => {
    const doc = buildWidgetSrcdoc({ html: HOSTILE });
    const headEnd = doc.indexOf('</head>');
    const bodyStart = doc.indexOf('<body>');
    const agent = doc.indexOf('id="agent"');
    expect(headEnd).toBeGreaterThan(-1);
    // The agent's own </head> only appears after <body>, where the parser ignores it.
    expect(doc.indexOf('</head>', headEnd + 1)).toBeGreaterThan(bodyStart);
    expect(bodyStart).toBeGreaterThan(headEnd);
    expect(agent).toBeGreaterThan(bodyStart);
    expect(doc.slice(0, bodyStart)).not.toContain('evil.example');
    expect(doc.slice(0, bodyStart)).not.toContain('agentRan');
  });

  it('removes <base> and <meta http-equiv> from agent markup, whatever the quoting or case', () => {
    const doc = buildWidgetSrcdoc({ html: HOSTILE });
    expect(doc).not.toMatch(/<base\b/i);
    expect(doc).not.toContain('evil.example');
    expect(doc.match(/http-equiv/gi)).toHaveLength(1); // ours
  });

  it('keeps ordinary meta tags and markup', () => {
    expect(neutralizeDocumentTags('<meta name="x" content="y"><b>kalın</b>')).toBe(
      '<meta name="x" content="y"><b>kalın</b>'
    );
  });

  it('uses the strict CSP profile with no network or external sources', () => {
    expect(WIDGET_CSP).toContain("default-src 'none'");
    expect(WIDGET_CSP).toContain("script-src 'unsafe-inline'");
    expect(WIDGET_CSP).toContain("style-src 'unsafe-inline'");
    expect(WIDGET_CSP).toContain('img-src data:');
    expect(WIDGET_CSP).toContain('font-src data:');
    expect(WIDGET_CSP).not.toContain('connect-src');
    expect(WIDGET_CSP).not.toMatch(/https?:|\*/);
    expect(buildWidgetSrcdoc({ html: '<p/>' })).toContain(`content="${WIDGET_CSP}"`);
  });

  it('draws svg input inside the document body', () => {
    const doc = buildWidgetSrcdoc({ svg: '<svg viewBox="0 0 10 10"><circle r="4"/></svg>' });
    expect(doc.slice(doc.indexOf('<body>'))).toContain('<svg viewBox="0 0 10 10">');
  });

  it('injects only colour-shaped theme values', () => {
    const doc = buildWidgetSrcdoc({
      html: '<p/>',
      colors: {
        bg: '#112233',
        fg: 'rgb(1, 2, 3)',
        accent: 'red;} body{background:url(https://evil.example)',
        border: 'oklch(0.5 0.1 200)',
      },
    });
    expect(doc).toContain('--widget-bg:#112233');
    expect(doc).toContain('--widget-fg:rgb(1, 2, 3)');
    expect(doc).toContain('--widget-border:oklch(0.5 0.1 200)');
    expect(doc).not.toContain('evil.example');
    expect(doc).not.toMatch(/--widget-accent:red/);
  });
});

describe('sandbox attribute', () => {
  it('is fixed to allow-scripts only', () => {
    expect(WIDGET_SANDBOX).toBe('allow-scripts');
    for (const forbidden of [
      'allow-same-origin',
      'allow-top-navigation',
      'allow-popups',
      'allow-forms',
      'allow-modals',
      'allow-downloads',
    ]) {
      expect(WIDGET_SANDBOX).not.toContain(forbidden);
    }
  });
});

describe('theme colours', () => {
  it('accepts hex, functional and transparent values only', () => {
    for (const ok of [
      '#fff',
      '#ffff',
      '#ffffff',
      '#ffffffff',
      'rgb(0 0 0 / 50%)',
      'rgba(0,0,0,.5)',
      'hsl(10, 20%, 30%)',
      'oklch(70% 0.1 20)',
      'transparent',
      'color(srgb 0.1 0.2 0.3)',
    ]) {
      expect(isSafeColorValue(ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      'red',
      'url(x)',
      'rgb(0,0,0); color:red',
      'var(--x)',
      '#12345',
      'rgb(0,0,0)}',
      'expression(1)',
      42,
      null,
      'rgb(' + '1'.repeat(100) + ')',
    ]) {
      expect(isSafeColorValue(bad), String(bad)).toBe(false);
    }
  });

  it('drops unknown keys and unsafe values', () => {
    expect(sanitizeThemeColors({ bg: '#000', other: '#fff', fg: 'javascript:1' })).toEqual({
      bg: '#000',
    });
  });
});
