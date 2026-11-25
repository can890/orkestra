import { describe, expect, it } from 'vitest';
import { contentRangeHeader, parseRangeHeader } from './range';

describe('parseRangeHeader', () => {
  const size = 1000;

  it('treats a missing header or a foreign unit as a full response', () => {
    expect(parseRangeHeader(null, size)).toEqual({ kind: 'full' });
    expect(parseRangeHeader(undefined, size)).toEqual({ kind: 'full' });
    expect(parseRangeHeader('items=0-5', size)).toEqual({ kind: 'full' });
  });

  it('parses closed, open-ended and suffix ranges', () => {
    expect(parseRangeHeader('bytes=0-99', size)).toEqual({
      kind: 'range',
      range: { start: 0, end: 99 },
    });
    expect(parseRangeHeader('bytes=500-', size)).toEqual({
      kind: 'range',
      range: { start: 500, end: 999 },
    });
    expect(parseRangeHeader('bytes=-100', size)).toEqual({
      kind: 'range',
      range: { start: 900, end: 999 },
    });
    // Dosyadan uzun sonek tüm dosyayı verir; taşan son konum kırpılır.
    expect(parseRangeHeader('bytes=-5000', size)).toEqual({
      kind: 'range',
      range: { start: 0, end: 999 },
    });
    expect(parseRangeHeader('bytes=990-5000', size)).toEqual({
      kind: 'range',
      range: { start: 990, end: 999 },
    });
    expect(parseRangeHeader(' Bytes = 10-20 ', size)).toEqual({
      kind: 'range',
      range: { start: 10, end: 20 },
    });
  });

  it('serves only the first range of a multi-range request', () => {
    expect(parseRangeHeader('bytes=0-9, 20-29', size)).toEqual({
      kind: 'range',
      range: { start: 0, end: 9 },
    });
  });

  it('rejects malformed and unsatisfiable ranges', () => {
    for (const header of [
      'bytes=1000-',
      'bytes=2000-3000',
      'bytes=20-10',
      'bytes=-0',
      'bytes=-',
      'bytes=abc',
      'bytes=1-2-3',
      'bytes',
      'bytes=99999999999999999999-',
    ]) {
      expect(parseRangeHeader(header, size), header).toEqual({ kind: 'unsatisfiable' });
    }
    expect(parseRangeHeader('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=-10', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('formats Content-Range', () => {
    expect(contentRangeHeader({ start: 0, end: 99 }, 1000)).toBe('bytes 0-99/1000');
  });
});
