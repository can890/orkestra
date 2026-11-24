import { describe, expect, it, vi } from 'vitest';
import type { PairingRecord } from '../pairing-store';
import { buildConfigurePayload, hostsSignature, nativeHostsFromRecords } from './host-sync';
import { parseLaunchTarget } from './launch-target';
import { describeHostNotificationStatus, parseAgentNotificationStatus } from './native';
import {
  AGENT_NOTIFICATION_PREFS_KEY,
  createAgentNotificationPrefsStore,
  DEFAULT_AGENT_NOTIFICATION_PREFS,
  normalizeAgentNotificationPrefs,
} from './preferences';
import { AgentNotificationSync } from './sync';

const SECRET = 'A'.repeat(43);

function record(overrides: Partial<PairingRecord> = {}): PairingRecord {
  return {
    hostId: 'mac-1',
    hostName: 'Mac',
    addresses: ['192.168.1.5', 'wss://abc.trycloudflare.com'],
    port: 51234,
    deviceId: 'device-0001-abcdef',
    secret: SECRET,
    pairedAt: 1,
    ...overrides,
  };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe('agent notification preferences', () => {
  it('defaults to off with every category and the ongoing card enabled', () => {
    expect(DEFAULT_AGENT_NOTIFICATION_PREFS).toEqual({
      enabled: false,
      finished: true,
      failed: true,
      approval: true,
      question: true,
      ongoing: true,
    });
  });

  it('normalizes corrupt values and drops unknown fields', () => {
    expect(normalizeAgentNotificationPrefs({ enabled: 'yes', failed: false, extra: 1 })).toEqual({
      ...DEFAULT_AGENT_NOTIFICATION_PREFS,
      failed: false,
    });
    expect(normalizeAgentNotificationPrefs(null)).toEqual(DEFAULT_AGENT_NOTIFICATION_PREFS);
  });

  it('persists updates and notifies subscribers', () => {
    const storage = memoryStorage();
    const store = createAgentNotificationPrefsStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);
    store.update({ enabled: true, question: false });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.map.get(AGENT_NOTIFICATION_PREFS_KEY)!)).toMatchObject({
      enabled: true,
      question: false,
    });
    expect(createAgentNotificationPrefsStore(storage).get()).toMatchObject({
      enabled: true,
      question: false,
    });
  });

  it('survives unreadable storage', () => {
    const broken = {
      getItem: () => '{not json',
      setItem: () => {
        throw new Error('quota');
      },
    };
    const store = createAgentNotificationPrefsStore(broken);
    expect(store.get()).toEqual(DEFAULT_AGENT_NOTIFICATION_PREFS);
    expect(store.update({ enabled: true }).enabled).toBe(true);
  });
});

describe('native host sync', () => {
  it('passes only valid hosts/addresses to the native service', () => {
    const hosts = nativeHostsFromRecords([
      record({ addresses: ['192.168.1.5', 'ws://plain.example', 'wss://abc.trycloudflare.com'] }),
      record({ hostId: 'broken', addresses: ['not an address!'] }),
    ]);
    expect(hosts).toEqual([
      {
        hostId: 'mac-1',
        hostName: 'Mac',
        addresses: ['192.168.1.5', 'wss://abc.trycloudflare.com'],
        port: 51234,
        deviceId: 'device-0001-abcdef',
        secret: SECRET,
      },
    ]);
  });

  it('never sends hosts (secrets) while background notifications are off', () => {
    const hosts = nativeHostsFromRecords([record()]);
    const off = JSON.parse(buildConfigurePayload(DEFAULT_AGENT_NOTIFICATION_PREFS, hosts));
    expect(off).toEqual({ prefs: DEFAULT_AGENT_NOTIFICATION_PREFS });
    const on = JSON.parse(
      buildConfigurePayload({ ...DEFAULT_AGENT_NOTIFICATION_PREFS, enabled: true }, hosts)
    );
    expect(on.hosts).toHaveLength(1);
  });

  it('keeps the plaintext secret out of the change signature', () => {
    const signature = hostsSignature(nativeHostsFromRecords([record()]));
    expect(signature).not.toContain(SECRET);
    expect(signature).not.toBe(
      hostsSignature(nativeHostsFromRecords([record({ secret: 'B'.repeat(43) })]))
    );
  });

  it('reconfigures only when prefs or connection-relevant host fields change', () => {
    const configure = vi.fn();
    const sync = new AgentNotificationSync(configure);
    const on = { ...DEFAULT_AGENT_NOTIFICATION_PREFS, enabled: true };
    expect(sync.sync(on, [record()])).toBe(true);
    expect(sync.sync(on, [record({ pairedAt: 99 })])).toBe(false);
    expect(sync.sync(on, [record({ addresses: ['10.0.0.7'] })])).toBe(true);
    expect(sync.sync({ ...on, question: false }, [record({ addresses: ['10.0.0.7'] })])).toBe(true);
    expect(sync.sync({ ...on, enabled: false }, [record()])).toBe(true);
    expect(JSON.parse(configure.mock.calls.at(-1)![0] as string)).not.toHaveProperty('hosts');
    sync.reset();
    expect(sync.sync({ ...on, enabled: false }, [record()])).toBe(true);
  });
});

describe('notification tap-through target', () => {
  it('accepts a well-formed target and rejects anything else', () => {
    expect(parseLaunchTarget('{"hostId":"mac-1","conversationId":"c-42"}')).toEqual({
      hostId: 'mac-1',
      conversationId: 'c-42',
    });
    expect(parseLaunchTarget('')).toBeNull();
    expect(parseLaunchTarget('{"hostId":"mac-1"}')).toBeNull();
    expect(parseLaunchTarget('{"hostId":"../x","conversationId":"c"}')).toBeNull();
    expect(parseLaunchTarget('not json')).toBeNull();
  });
});

describe('native status parsing', () => {
  it('reads the bridge status JSON loosely', () => {
    const status = parseAgentNotificationStatus(
      JSON.stringify({
        supported: true,
        sdk: 35,
        enabled: true,
        running: true,
        permission: 'denied',
        notificationsEnabled: false,
        batteryOptimized: true,
        hosts: { 'mac-1': 'connected', bad: 3 },
      })
    );
    expect(status).toMatchObject({
      supported: true,
      sdk: 35,
      permission: 'denied',
      batteryOptimized: true,
      hosts: { 'mac-1': 'connected' },
    });
    expect(parseAgentNotificationStatus('garbage').supported).toBe(false);
    expect(describeHostNotificationStatus('unsupported')).toContain('desteklemiyor');
  });
});
