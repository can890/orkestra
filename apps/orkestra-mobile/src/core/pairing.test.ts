import { base64UrlEncode } from '@orkestra/wire/remote';
import { describe, expect, it } from 'vitest';
import { describePairingFailure, isValidAddress, parsePairingPayload } from './pairing';

const SECRET = base64UrlEncode(new Uint8Array(32).fill(7));

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    k: 'orkestra-pair',
    v: 1,
    h: 'host-0001',
    n: 'Selim-Mac',
    a: ['192.168.1.20', '100.101.102.103'],
    p: 51234,
    d: 'device-0001-abcdef',
    s: SECRET,
    ...overrides,
  });
}

describe('parsePairingPayload', () => {
  it('geçerli QR yükünü ayrıştırır', () => {
    const result = parsePairingPayload(payload());
    expect(result).toEqual({
      ok: true,
      payload: {
        h: 'host-0001',
        n: 'Selim-Mac',
        a: ['192.168.1.20', '100.101.102.103'],
        p: 51234,
        d: 'device-0001-abcdef',
        s: SECRET,
      },
    });
  });

  it('elle yapıştırılan metindeki baştaki/sondaki boşlukları yok sayar', () => {
    expect(parsePairingPayload(`\n  ${payload()}  \n`).ok).toBe(true);
  });

  it('yinelenen adresleri tekilleştirir', () => {
    const result = parsePairingPayload(payload({ a: ['10.0.0.2', '10.0.0.2', '10.0.0.3'] }));
    expect(result.ok && result.payload.a).toEqual(['10.0.0.2', '10.0.0.3']);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['merhaba', 'not-json'],
    ['{"k":"baska"}', 'not-orkestra'],
    ['[1,2]', 'not-orkestra'],
    [payload({ v: 2 }), 'unsupported-version'],
    [payload({ h: '' }), 'invalid'],
    [payload({ a: [] }), 'invalid'],
    [payload({ a: ['1.2.3.4', 'a/b'] }), 'invalid'],
    [payload({ a: ['999.1.1.1'] }), 'invalid'],
    [payload({ a: ['x'.repeat(7)].concat(Array(6).fill('10.0.0.1')) }), 'invalid'],
    [payload({ p: 0 }), 'invalid'],
    [payload({ p: 70000 }), 'invalid'],
    [payload({ p: 80.5 }), 'invalid'],
    [payload({ d: 'kisa' }), 'invalid'],
    [payload({ s: 'kisa' }), 'invalid'],
    [payload({ s: `${SECRET.slice(0, 42)}!` }), 'invalid'],
    [payload({ n: 'x'.repeat(65) }), 'invalid'],
    ['x'.repeat(5000), 'too-large'],
  ])('reddeder: %#', (input, reason) => {
    expect(parsePairingPayload(input)).toEqual({ ok: false, reason });
  });

  it('hata açıklamaları sırrı içermez', () => {
    for (const reason of [
      'empty',
      'too-large',
      'not-json',
      'not-orkestra',
      'unsupported-version',
      'invalid',
    ] as const) {
      expect(describePairingFailure(reason)).not.toContain(SECRET);
    }
  });
});

describe('isValidAddress', () => {
  it('IPv4, IPv6 ve ana makine adlarını kabul eder', () => {
    expect(isValidAddress('192.168.1.20')).toBe(true);
    expect(isValidAddress('fe80::1')).toBe(true);
    expect(isValidAddress('mac.local')).toBe(true);
  });
  it('yol, kimlik ve boşluk içeren değerleri reddeder', () => {
    expect(isValidAddress('evil.com/x')).toBe(false);
    expect(isValidAddress('user@host')).toBe(false);
    expect(isValidAddress('a b')).toBe(false);
    expect(isValidAddress('')).toBe(false);
    expect(isValidAddress(42)).toBe(false);
  });
});
