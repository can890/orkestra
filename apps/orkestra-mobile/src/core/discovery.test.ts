import { base64UrlEncode, remoteWebSocketUrl } from '@orkestra/wire/remote';
import { describe, expect, it } from 'vitest';
import { AppSession } from './app-session';
import { parseDiscoveryDocument } from './discovery';
import { isValidAddress, type PairingPayload } from './pairing';
import {
  createMemorySecureStore,
  createPairingRepository,
  recordFromPayload,
} from './pairing-store';

function samplePayload(hostId: string, name: string, addr: string): PairingPayload {
  return {
    h: hostId,
    n: name,
    a: [addr],
    p: 55254,
    d: 'dev_' + hostId.slice(0, 8),
    s: base64UrlEncode(new Uint8Array(32).fill(7)),
  };
}

describe('wss:// tünel adresi ve dinamik keşif', () => {
  it('wss:// trycloudflare.com adresini geçerli sayar, düz ws:// ve kullanıcı bilgisi reddeder', () => {
    expect(isValidAddress('wss://foo-bar-baz.trycloudflare.com')).toBe(true);
    expect(isValidAddress('192.168.1.20')).toBe(true);
    expect(isValidAddress('ws://evil.example.com')).toBe(false);
    expect(isValidAddress('wss://user:pass@foo.trycloudflare.com')).toBe(false);
    expect(isValidAddress('wss://foo.trycloudflare.com?token=1')).toBe(false);
  });

  it('remoteWebSocketUrl wss:// tünel adresine standart yolu ekler', () => {
    expect(remoteWebSocketUrl('wss://demo-xyz.trycloudflare.com', 55254)).toBe(
      'wss://demo-xyz.trycloudflare.com/orkestra-remote/v1'
    );
    expect(remoteWebSocketUrl('192.168.1.10', 55254)).toBe(
      'ws://192.168.1.10:55254/orkestra-remote/v1'
    );
  });

  it('GitHub Gist yanıtından ilgili hostId için tünel ve LAN adreslerini ayrıştırır', () => {
    const gistApiResponse = {
      files: {
        'sovra-endpoints.json': {
          content: JSON.stringify({
            v: 1,
            hosts: {
              'host-mac': {
                name: 'Mac',
                tunnelUrl: 'wss://mac-live.trycloudflare.com',
                addresses: ['wss://mac-live.trycloudflare.com', '192.168.1.50', 'ws://bad'],
                port: 55254,
                updatedAt: 1700000000000,
              },
            },
          }),
        },
      },
    };
    const parsed = parseDiscoveryDocument(gistApiResponse, 'host-mac');
    expect(parsed).toEqual({
      addresses: ['wss://mac-live.trycloudflare.com', '192.168.1.50'],
      port: 55254,
      name: 'Mac',
      updatedAt: 1700000000000,
    });
    expect(parseDiscoveryDocument(gistApiResponse, 'unknown-host')).toBeNull();
  });
});

describe('çoklu bilgisayar (Mac + Huawei) ve otomatik failover', () => {
  it('iki bilgisayarı saklar, v1 kaydını bozmadan taşır ve elle geçiş yapar', async () => {
    const store = createMemorySecureStore();
    const mac = recordFromPayload(samplePayload('host-mac-001', 'Mac', '192.168.1.10'), 100);
    await store.set('orkestra.pairing.v1', JSON.stringify(mac));

    const repo = createPairingRepository(store);
    const loaded = await repo.loadAll();
    expect(loaded?.hosts.map((h) => h.hostId)).toEqual(['host-mac-001']);

    const huawei = recordFromPayload(
      samplePayload('host-huawei1', 'Huawei', 'wss://hw.trycloudflare.com'),
      200
    );
    await repo.save(huawei);
    const both = await repo.loadAll();
    expect(both?.activeHostId).toBe('host-huawei1');
    expect(both?.hosts.map((h) => h.hostId)).toEqual(['host-huawei1', 'host-mac-001']);

    await repo.setActiveHost('host-mac-001');
    expect((await repo.load())?.hostId).toBe('host-mac-001');
  });

  it('aktif bilgisayar ardışık başarısız olunca diğer kayıtlı bilgisayara otomatik geçer', async () => {
    const repo = createPairingRepository(createMemorySecureStore());
    const activated: string[] = [];
    let triggerFail: (() => void) | undefined;

    const session = new AppSession({
      repository: repo,
      clientName: 'Android',
      platform: 'android',
      failoverAfterRounds: 2,
      createManager: (opts) => {
        activated.push(opts.record.hostId);
        triggerFail = opts.onRoundFailed;
        return {
          connection: {
            call: async () => undefined,
            snapshot: async () => undefined,
            attach: () => ({ dispose: () => {} }),
            dispose: () => {},
          } as never,
          status: () => ({ kind: 'connecting', attempt: 1 }),
          subscribe: () => () => {},
          verifyConnection: () => {},
          refresh: () => {},
          stop: () => {},
        };
      },
    });

    await session.pair(samplePayload('host-mac-001', 'Mac', '192.168.1.10'));
    await session.pair(samplePayload('host-huawei1', 'Huawei', 'wss://hw.trycloudflare.com'));
    await session.switchHost('host-mac-001');
    expect(activated.at(-1)).toBe('host-mac-001');

    triggerFail?.();
    expect(activated.at(-1)).toBe('host-mac-001');
    triggerFail?.();
    await new Promise((r) => setTimeout(r, 15));
    expect(activated.at(-1)).toBe('host-huawei1');
  });
});
