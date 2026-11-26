import { describe, expect, it } from 'vitest';
import { extractLinkHref } from './selection-context-menu';

describe('extractLinkHref', () => {
  it('returns the href when right-clicking directly on or inside an anchor', () => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'https://github.com/can890/orkestra/releases');
    const span = document.createElement('span');
    span.textContent = 'Releases';
    anchor.appendChild(span);

    expect(extractLinkHref(anchor)).toBe('https://github.com/can890/orkestra/releases');
    expect(extractLinkHref(span)).toBe('https://github.com/can890/orkestra/releases');
    expect(extractLinkHref(span.firstChild)).toBe('https://github.com/can890/orkestra/releases');
  });

  it('preserves file:// links verbatim and returns empty string outside links', () => {
    const fileAnchor = document.createElement('a');
    fileAnchor.setAttribute('href', 'file:///Users/selim/test.ts#L10');
    const plain = document.createElement('p');
    plain.textContent = 'Düz metin';

    expect(extractLinkHref(fileAnchor)).toBe('file:///Users/selim/test.ts#L10');
    expect(extractLinkHref(plain)).toBe('');
    expect(extractLinkHref(null)).toBe('');
  });
});
