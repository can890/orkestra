import { describe, expect, it } from 'vitest';
import { parseGrokBillingFrames } from './grok-billing';
const actual = Buffer.from('00000000300a2e12001a0022060880c5f6d5062a060880ba9bd6064212080212060880c5f6d5061a060880ba9bd606580162006801800000000f677270632d7374617475733a300d0a', 'hex');
const now = Date.parse('2026-10-02T15:00:00Z');
function withPercent(value: number) {
  const scalar = Buffer.alloc(5); scalar[0] = 13; scalar.writeFloatLE(value, 1);
  const config = Buffer.concat([actual.subarray(7, 53), scalar]);
  const message = Buffer.concat([Buffer.from([10, config.length]), config]);
  const header = Buffer.alloc(5); header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, message, actual.subarray(53)]);
}
describe('Grok verified billing protobuf', () => {
  it('reads the actual active-period response with proto3 zero usage', () => {
    expect(parseGrokBillingFrames(actual, now)).toEqual({ usedPercent: 0, weekly: true, resetsAt: '2026-10-08T00:00:00.000Z' });
  });
  it('preserves published nonzero usage and exhausted quota', () => {
    expect(parseGrokBillingFrames(withPercent(24.5), now)?.usedPercent).toBe(24.5);
    expect(parseGrokBillingFrames(withPercent(100), now)?.usedPercent).toBe(100);
  });
  it('does not infer zero from historical, future, incomplete or unsuccessful responses', () => {
    expect(parseGrokBillingFrames(actual, Date.parse('2026-10-09'))).toBeUndefined();
    expect(parseGrokBillingFrames(actual, Date.parse('2026-09-30'))).toBeUndefined();
    for (let n = 0; n < actual.length; n++) expect(parseGrokBillingFrames(actual.subarray(0, n), now)).toBeUndefined();
    expect(parseGrokBillingFrames(Buffer.from(actual.toString('hex').replace('7374617475733a30', '7374617475733a31'), 'hex'), now)).toBeUndefined();
  });
  it('rejects invalid published measurements', () => {
    for (const v of [-1, 101, Infinity, NaN]) expect(parseGrokBillingFrames(withPercent(v), now)).toBeUndefined();
  });
});
