import { describe, expect, it } from 'vitest';
import { encodeQr, qrToSvgPath } from './qr-code';

function finderAt(modules: boolean[][], x0: number, y0: number): boolean {
  for (let dy = 0; dy < 7; dy += 1) {
    for (let dx = 0; dx < 7; dx += 1) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      const expected = ring !== 2;
      if (modules[y0 + dy]![x0 + dx] !== expected) return false;
    }
  }
  return true;
}

/** BCH(15,5) biçim bilgisini doğrular: geçerli bir kod sözcüğü olmalı. */
function readFormat(modules: boolean[][]): number {
  const size = modules.length;
  let bits = 0;
  for (let i = 0; i <= 5; i += 1) bits |= (modules[i]![8] ? 1 : 0) << i;
  bits |= (modules[7]![8] ? 1 : 0) << 6;
  bits |= (modules[8]![8] ? 1 : 0) << 7;
  bits |= (modules[8]![7] ? 1 : 0) << 8;
  for (let i = 9; i < 15; i += 1) bits |= (modules[8]![14 - i] ? 1 : 0) << i;
  // ikinci kopya ile aynı olmalı
  let second = 0;
  for (let i = 0; i < 8; i += 1) second |= (modules[8]![size - 1 - i] ? 1 : 0) << i;
  for (let i = 8; i < 15; i += 1) second |= (modules[size - 15 + i]![8] ? 1 : 0) << i;
  expect(second).toBe(bits);
  return bits ^ 0x5412;
}

function bchRemainder(value: number): number {
  let rem = value;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return rem;
}

describe('encodeQr', () => {
  it('chooses the smallest version and draws finder, timing patterns and a valid format word', () => {
    const small = encodeQr('merhaba');
    expect(small.version).toBe(1);
    expect(small.size).toBe(21);

    const big = encodeQr('x'.repeat(250));
    expect(big.version).toBeGreaterThan(8);
    expect(big.size).toBe(big.version * 4 + 17);

    for (const matrix of [small, big]) {
      const { modules, size } = matrix;
      expect(finderAt(modules, 0, 0)).toBe(true);
      expect(finderAt(modules, size - 7, 0)).toBe(true);
      expect(finderAt(modules, 0, size - 7)).toBe(true);
      for (let i = 8; i < size - 8; i += 1) {
        expect(modules[6]![i]).toBe(i % 2 === 0);
        expect(modules[i]![6]).toBe(i % 2 === 0);
      }
      const format = readFormat(modules);
      // Düzey M (00) + maske (3 bit) ve geçerli BCH kalanı.
      expect(format >>> 13).toBe(0);
      expect(bchRemainder(format >>> 10)).toBe(format & 0x3ff);
      expect(modules[size - 8]![8]).toBe(true); // her zaman koyu modül
    }
  });

  it('is deterministic and rejects payloads beyond version 14', () => {
    expect(encodeQr('aynı').modules).toEqual(encodeQr('aynı').modules);
    expect(() => encodeQr('x'.repeat(400))).toThrow();
  });

  it('renders an svg path covering every dark module exactly once', () => {
    const matrix = encodeQr('svg');
    const { d, viewSize } = qrToSvgPath(matrix, 4);
    expect(viewSize).toBe(matrix.size + 8);
    const dark = matrix.modules.flat().filter(Boolean).length;
    let covered = 0;
    for (const match of d.matchAll(/h(\d+)v1/g)) covered += Number(match[1]);
    expect(covered).toBe(dark);
  });
});
