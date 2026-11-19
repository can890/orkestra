import { describe, expect, it } from 'vitest';
import { candidateAddresses, isTailscaleAddress } from './network-addresses';

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal });

describe('candidateAddresses', () => {
  it('orders LAN first, Tailscale second and drops loopback, link-local and virtual bridges', () => {
    const result = candidateAddresses({
      lo0: [v4('127.0.0.1', true)],
      en0: [v4('192.168.1.20'), { address: 'fe80::1', family: 'IPv6', internal: false }],
      utun4: [v4('100.101.102.103')],
      docker0: [v4('172.17.0.1')],
      'br-abc': [v4('172.18.0.1')],
      en1: [v4('169.254.10.2')],
      en2: [v4('10.0.0.5')],
      ppp0: [v4('8.8.4.4')],
    });
    expect(result).toEqual(['192.168.1.20', '10.0.0.5', '100.101.102.103', '8.8.4.4']);
  });

  it('accepts numeric family values and de-duplicates', () => {
    expect(
      candidateAddresses({
        a: [{ address: '192.168.0.2', family: 4, internal: false }],
        b: [{ address: '192.168.0.2', family: 4, internal: false }],
      })
    ).toEqual(['192.168.0.2']);
  });

  it('recognises only 100.64.0.0/10 as Tailscale', () => {
    expect(isTailscaleAddress('100.64.0.1')).toBe(true);
    expect(isTailscaleAddress('100.127.255.255')).toBe(true);
    expect(isTailscaleAddress('100.63.0.1')).toBe(false);
    expect(isTailscaleAddress('100.128.0.1')).toBe(false);
    expect(isTailscaleAddress('not-an-ip')).toBe(false);
  });
});
