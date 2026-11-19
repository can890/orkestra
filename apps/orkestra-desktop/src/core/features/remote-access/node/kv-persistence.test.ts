import { describe, expect, it } from 'vitest';
import { parseStoredRemoteAccessState } from './kv-persistence';

const device = {
  id: 'device-1234',
  name: 'Pixel 9',
  platform: 'android',
  createdAt: 1,
  pairedAt: 2,
  expiresAt: null,
  lastSeenAt: 3,
};

describe('parseStoredRemoteAccessState', () => {
  it('loads an old stored state without accountPairing and keeps its devices', () => {
    const old = { version: 1, hostId: 'host-1', enabled: true, port: 50123, devices: [device] };
    const state = parseStoredRemoteAccessState(old);
    expect(state).toEqual(old);
    expect(state?.accountPairing).toBeUndefined();
  });

  it('round-trips the accountPairing block', () => {
    const next = {
      version: 1,
      hostId: 'host-1',
      enabled: true,
      port: null,
      accountPairing: { enabled: true, gistId: 'abcdef0123456789', publicKey: 'AAAA' },
      devices: [device],
    };
    expect(parseStoredRemoteAccessState(JSON.parse(JSON.stringify(next)))).toEqual(next);
  });

  it('ignores a malformed accountPairing block without dropping devices', () => {
    const bad = {
      version: 1,
      hostId: 'host-1',
      enabled: true,
      port: 1,
      accountPairing: { enabled: 'yes' },
      devices: [device],
    };
    const state = parseStoredRemoteAccessState(bad);
    expect(state?.devices).toEqual([device]);
    expect(state?.accountPairing).toBeUndefined();
  });
});
