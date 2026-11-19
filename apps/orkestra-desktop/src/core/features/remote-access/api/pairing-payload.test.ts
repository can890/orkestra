import { describe, expect, it } from 'vitest';
import {
  PAIRING_PAYLOAD_KIND,
  parsePairingPayload,
  serializePairingPayload,
  type PairingPayload,
} from './pairing-payload';

const payload: PairingPayload = {
  k: PAIRING_PAYLOAD_KIND,
  v: 1,
  h: '8f14e45f-ceea-4672-a4d4-0a0b0c0d0e0f',
  n: 'Selim’in Mac',
  a: ['192.168.1.20', '100.101.102.103'],
  p: 51234,
  d: '3b241101-e2bb-4255-8caf-4136c566a962',
  s: 'A'.repeat(43),
};

describe('pairing payload', () => {
  it('round-trips and stays small enough for a single QR code', () => {
    const text = serializePairingPayload(payload);
    expect(parsePairingPayload(text)).toEqual(payload);
    expect(new TextEncoder().encode(text).length).toBeLessThan(331);
  });

  it('rejects foreign, malformed or out-of-range payloads', () => {
    expect(parsePairingPayload('not json')).toBeNull();
    expect(parsePairingPayload(JSON.stringify({ ...payload, k: 'other' }))).toBeNull();
    expect(parsePairingPayload(JSON.stringify({ ...payload, v: 2 }))).toBeNull();
    expect(parsePairingPayload(JSON.stringify({ ...payload, p: 70000 }))).toBeNull();
    expect(parsePairingPayload(JSON.stringify({ ...payload, s: 'short' }))).toBeNull();
    expect(parsePairingPayload(JSON.stringify({ ...payload, d: 'bad id!' }))).toBeNull();
  });
});
