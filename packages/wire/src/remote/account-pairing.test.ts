import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_PAIRING_MAX_REQUESTS,
  ACCOUNT_PAIRING_REQUEST_TTL_MS,
  deriveAccountPairingSecret,
  emptyAccountPairingDocument,
  generateAccountPairingKeyPair,
  isAccountPairingPublicKey,
  isAccountPairingRequestExpired,
  parseAccountPairingDocument,
  serializeAccountPairingDocument,
  withAccountPairingHost,
  withAccountPairingRequest,
  withoutAccountPairingHost,
  withoutAccountPairingRequests,
  type AccountPairingHost,
  type AccountPairingRequest,
} from './account-pairing';
import { base64UrlEncode } from './bytes';
import { deriveChannelKeys, createFrameOpener, createFrameSealer } from './crypto';
import { REMOTE_NONCE_BYTES, REMOTE_SECRET_BYTES } from './protocol';

const HOST_ID = '3f0c1a52-6d1e-4b8e-9f0a-2b7c5d9e1a44';
const DEVICE_ID = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const NOW = 1_800_000_000_000;

async function host(overrides: Partial<AccountPairingHost> = {}): Promise<AccountPairingHost> {
  const keys = await generateAccountPairingKeyPair();
  return {
    id: HOST_ID,
    name: 'Ornek-Mac',
    addresses: ['192.168.1.20', '100.64.0.7'],
    port: 50123,
    publicKey: keys.publicKey,
    updatedAt: NOW,
    ...overrides,
  };
}

async function request(
  overrides: Partial<AccountPairingRequest> = {}
): Promise<AccountPairingRequest> {
  const keys = await generateAccountPairingKeyPair();
  return {
    deviceId: DEVICE_ID,
    hostId: HOST_ID,
    name: 'Pixel',
    platform: 'android',
    publicKey: keys.publicKey,
    createdAt: NOW,
    ...overrides,
  };
}

describe('account pairing key agreement', () => {
  it('derives the same 32-byte secret on the desktop and on the phone', async () => {
    const desktop = await generateAccountPairingKeyPair();
    const phone = await generateAccountPairingKeyPair();
    expect(isAccountPairingPublicKey(desktop.publicKey)).toBe(true);

    const onDesktop = await deriveAccountPairingSecret({
      role: 'host',
      privateKey: desktop.privateKey,
      ownPublicKey: desktop.publicKey,
      peerPublicKey: phone.publicKey,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    const onPhone = await deriveAccountPairingSecret({
      role: 'device',
      privateKey: phone.privateKey,
      ownPublicKey: phone.publicKey,
      peerPublicKey: desktop.publicKey,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });

    expect(onDesktop.byteLength).toBe(REMOTE_SECRET_BYTES);
    expect(base64UrlEncode(onDesktop)).toBe(base64UrlEncode(onPhone));
  });

  it('produces a secret the existing remote handshake accepts', async () => {
    const desktop = await generateAccountPairingKeyPair();
    const phone = await generateAccountPairingKeyPair();
    const shared = { hostId: HOST_ID, deviceId: DEVICE_ID };
    const [serverSecret, clientSecret] = await Promise.all([
      deriveAccountPairingSecret({
        ...shared,
        role: 'host',
        privateKey: desktop.privateKey,
        ownPublicKey: desktop.publicKey,
        peerPublicKey: phone.publicKey,
      }),
      deriveAccountPairingSecret({
        ...shared,
        role: 'device',
        privateKey: phone.privateKey,
        ownPublicKey: phone.publicKey,
        peerPublicKey: desktop.publicKey,
      }),
    ]);
    const clientNonce = new Uint8Array(REMOTE_NONCE_BYTES).fill(1);
    const serverNonce = new Uint8Array(REMOTE_NONCE_BYTES).fill(2);
    const client = await deriveChannelKeys('client', clientSecret, clientNonce, serverNonce);
    const server = await deriveChannelKeys('server', serverSecret, clientNonce, serverNonce);

    const frame = await createFrameSealer(client.send, client.sendDirection).seal(
      new TextEncoder().encode('merhaba')
    );
    const opened = await createFrameOpener(server.receive, server.receiveDirection).open(frame);
    expect(new TextDecoder().decode(opened)).toBe('merhaba');
  });

  it('binds the secret to the device, the host and both public keys', async () => {
    const desktop = await generateAccountPairingKeyPair();
    const phone = await generateAccountPairingKeyPair();
    const base = {
      role: 'host' as const,
      privateKey: desktop.privateKey,
      ownPublicKey: desktop.publicKey,
      peerPublicKey: phone.publicKey,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    };
    const secret = base64UrlEncode(await deriveAccountPairingSecret(base));
    const otherDevice = await deriveAccountPairingSecret({
      ...base,
      deviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    const otherHost = await deriveAccountPairingSecret({
      ...base,
      hostId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    const wrongRole = await deriveAccountPairingSecret({ ...base, role: 'device' });

    expect(base64UrlEncode(otherDevice)).not.toBe(secret);
    expect(base64UrlEncode(otherHost)).not.toBe(secret);
    expect(base64UrlEncode(wrongRole)).not.toBe(secret);
  });

  it('gives an eavesdropper who only knows the public keys a different secret', async () => {
    const desktop = await generateAccountPairingKeyPair();
    const phone = await generateAccountPairingKeyPair();
    const attacker = await generateAccountPairingKeyPair();
    const real = await deriveAccountPairingSecret({
      role: 'host',
      privateKey: desktop.privateKey,
      ownPublicKey: desktop.publicKey,
      peerPublicKey: phone.publicKey,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    const guessed = await deriveAccountPairingSecret({
      role: 'device',
      privateKey: attacker.privateKey,
      ownPublicKey: phone.publicKey,
      peerPublicKey: desktop.publicKey,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    expect(base64UrlEncode(guessed)).not.toBe(base64UrlEncode(real));
  });

  it('rejects malformed keys and identifiers without leaking them', async () => {
    const desktop = await generateAccountPairingKeyPair();
    const phone = await generateAccountPairingKeyPair();
    const base = {
      role: 'host' as const,
      privateKey: desktop.privateKey,
      ownPublicKey: desktop.publicKey,
      peerPublicKey: phone.publicKey,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    };
    // 65 bayt ve 0x04 ile başlıyor ama eğri üzerinde değil.
    const offCurve = base64UrlEncode(new Uint8Array(65).fill(7).fill(4, 0, 1));

    await expect(deriveAccountPairingSecret({ ...base, peerPublicKey: 'kisa' })).rejects.toThrow(
      'Invalid pairing public key'
    );
    await expect(deriveAccountPairingSecret({ ...base, peerPublicKey: offCurve })).rejects.toThrow(
      'Pairing key agreement failed'
    );
    await expect(
      deriveAccountPairingSecret({ ...base, peerPublicKey: desktop.publicKey })
    ).rejects.toThrow('Invalid pairing public key');
    await expect(deriveAccountPairingSecret({ ...base, deviceId: 'x' })).rejects.toThrow(
      'Invalid pairing identifiers'
    );
  });
});

describe('account pairing document', () => {
  it('round-trips hosts and requests', async () => {
    const document = withAccountPairingRequest(
      withAccountPairingHost(emptyAccountPairingDocument(), await host()),
      await request()
    );
    expect(parseAccountPairingDocument(serializeAccountPairingDocument(document))).toEqual(
      document
    );
  });

  it('returns null for anything that is not a pairing document', () => {
    expect(parseAccountPairingDocument('')).toBeNull();
    expect(parseAccountPairingDocument('{')).toBeNull();
    expect(parseAccountPairingDocument('[]')).toBeNull();
    expect(parseAccountPairingDocument(JSON.stringify({ k: 'other', v: 1 }))).toBeNull();
    expect(
      parseAccountPairingDocument(JSON.stringify({ k: 'orkestra-account-pairing', v: 2 }))
    ).toBeNull();
    expect(parseAccountPairingDocument('x'.repeat(40_000))).toBeNull();
    expect(parseAccountPairingDocument(42)).toBeNull();
  });

  it('drops invalid entries but keeps the valid ones', async () => {
    const good = await host();
    const goodRequest = await request();
    const text = JSON.stringify({
      k: 'orkestra-account-pairing',
      v: 1,
      hosts: [
        good,
        { ...good, id: 'başka', addresses: ['192.168.1.5'] },
        { ...good, id: 'aaaaaaaa-1111', addresses: ['999.1.1.1'] },
        { ...good, id: 'aaaaaaaa-2222', addresses: ['http://evil.example/x'] },
        { ...good, id: 'aaaaaaaa-3333', port: 70000 },
        { ...good, id: 'aaaaaaaa-4444', publicKey: 'AAAA' },
        { ...good, id: 'aaaaaaaa-5555', name: 'x'.repeat(65) },
        null,
      ],
      requests: [
        goodRequest,
        { ...goodRequest, deviceId: 'bbbbbbbb-1111', publicKey: 'AAAA' },
        { ...goodRequest, deviceId: 'bbbbbbbb-2222', hostId: '' },
        { ...goodRequest, deviceId: 'bbbbbbbb-3333', createdAt: -1 },
        'x',
      ],
      extra: 'ignored',
    });
    const parsed = parseAccountPairingDocument(text);
    expect(parsed?.hosts).toEqual([good]);
    expect(parsed?.requests).toEqual([goodRequest]);
  });

  it('keeps the newest request per device and caps the list', async () => {
    let document = emptyAccountPairingDocument();
    const first = await request({ createdAt: NOW });
    const second = await request({ createdAt: NOW + 5 });
    document = withAccountPairingRequest(document, first);
    document = withAccountPairingRequest(document, second);
    expect(document.requests).toEqual([second]);

    for (let i = 0; i < ACCOUNT_PAIRING_MAX_REQUESTS + 3; i += 1) {
      document = withAccountPairingRequest(
        document,
        await request({
          deviceId: `cccccccc-${String(i).padStart(4, '0')}`,
          createdAt: NOW + 10 + i,
        })
      );
    }
    expect(document.requests).toHaveLength(ACCOUNT_PAIRING_MAX_REQUESTS);
    expect(document.requests[0]?.deviceId).toBe(
      `cccccccc-${String(ACCOUNT_PAIRING_MAX_REQUESTS + 2).padStart(4, '0')}`
    );
    expect(document.requests.some((entry) => entry.deviceId === DEVICE_ID)).toBe(false);
  });

  it('updates a host in place and removes it together with its requests', async () => {
    const original = await host();
    const moved = { ...original, addresses: ['10.0.0.9'], updatedAt: NOW + 1 };
    let document = withAccountPairingHost(emptyAccountPairingDocument(), original);
    document = withAccountPairingHost(document, moved);
    expect(document.hosts).toEqual([moved]);

    document = withAccountPairingRequest(document, await request());
    document = withAccountPairingRequest(
      document,
      await request({ deviceId: 'dddddddd-0001', hostId: 'eeeeeeee-0001' })
    );
    expect(withoutAccountPairingRequests(document, [DEVICE_ID]).requests).toHaveLength(1);

    const removed = withoutAccountPairingHost(document, HOST_ID);
    expect(removed.hosts).toEqual([]);
    expect(removed.requests.map((entry) => entry.deviceId)).toEqual(['dddddddd-0001']);
  });

  it('expires requests that are too old or come from a clock far in the future', async () => {
    const entry = await request({ createdAt: NOW });
    expect(isAccountPairingRequestExpired(entry, NOW + ACCOUNT_PAIRING_REQUEST_TTL_MS)).toBe(false);
    expect(isAccountPairingRequestExpired(entry, NOW + ACCOUNT_PAIRING_REQUEST_TTL_MS + 1)).toBe(
      true
    );
    expect(isAccountPairingRequestExpired(entry, NOW - ACCOUNT_PAIRING_REQUEST_TTL_MS - 1)).toBe(
      true
    );
  });
});
