import { createCipheriv, hkdfSync, randomBytes as nodeRandomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { connect } from '../api/connect';
import { defineContract, procedure } from '../api/define';
import { client } from '../rpc/client';
import { createController } from '../rpc/controller';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from './bytes';
import { decodeEnvelope } from './channel';
import { connectRemoteTransport, RemoteHandshakeError } from './client';
import { createFrameOpener, createFrameSealer, deriveChannelKeys } from './crypto';
import { createMemorySocketPair } from './memory-socket';
import { AuthRateLimiter } from './node/rate-limiter';
import { createRemoteServer, type RemoteServer } from './node/server';
import { REMOTE_CLOSE, REMOTE_DIRECTION_C2S, REMOTE_KDF_INFO_C2S } from './protocol';

const DEVICE_ID = 'device-0001-abcdef';
const SECRET = new Uint8Array(32).fill(7);

const contract = defineContract({
  echo: procedure({ input: z.object({ text: z.string() }), output: z.string() }),
});
const controller = createController(contract, { echo: ({ text }) => `echo:${text}` });

type Harness = {
  server: RemoteServer;
  rejected: string[];
  opened: string[];
  closed: string[];
  secrets: Map<string, Uint8Array>;
  limiter: AuthRateLimiter;
  clock: { now: number };
};

function harness(
  overrides: { limits?: Parameters<typeof createRemoteServer>[0]['limits'] } = {}
): Harness {
  const secrets = new Map<string, Uint8Array>([[DEVICE_ID, SECRET]]);
  const rejected: string[] = [];
  const opened: string[] = [];
  const closed: string[] = [];
  const clock = { now: 1_000_000 };
  const limiter = new AuthRateLimiter({ now: () => clock.now });
  const server = createRemoteServer({
    controller,
    lookupSecret: async (id) => secrets.get(id) ?? null,
    hostInfo: () => ({
      hostId: 'host-1',
      hostName: 'Masaüstü',
      addresses: ['192.168.1.5'],
      port: 4000,
    }),
    rateLimiter: limiter,
    limits: overrides.limits,
    onRejected: (info) => rejected.push(info.reason),
    onSessionOpen: (info) => opened.push(info.deviceId),
    onSessionClose: (info) => closed.push(info.deviceId),
    now: () => clock.now,
  });
  return { server, rejected, opened, closed, secrets, limiter, clock };
}

function connectClient(
  h: Harness,
  opts: { deviceId?: string; secret?: Uint8Array; address?: string } = {}
) {
  const pair = createMemorySocketPair();
  h.server.handleConnection(pair.server, opts.address ?? '10.0.0.9');
  const promise = connectRemoteTransport({
    url: 'ws://memory/orkestra-remote/v1',
    deviceId: opts.deviceId ?? DEVICE_ID,
    secret: opts.secret ?? SECRET,
    clientName: 'Test Telefon',
    platform: 'android',
    createSocket: () => pair.client,
    handshakeTimeoutMs: 2000,
    pingIntervalMs: 0,
    idleTimeoutMs: 0,
  });
  return { pair, promise };
}

describe('base64url', () => {
  it('round-trips and rejects padding or foreign characters', () => {
    const bytes = new Uint8Array([0, 255, 128, 1, 2, 3, 4]);
    expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
    expect(base64UrlDecode('abc=')).toBeNull();
    expect(base64UrlDecode('a+b/')).toBeNull();
    expect(base64UrlDecode('abcde')).toBeNull();
    expect(base64UrlEncode(new Uint8Array(32)).length).toBe(43);
  });
});

describe('frame cipher', () => {
  it('interoperates with Node crypto (HKDF-SHA256 + AES-256-GCM, nonce = direction || counter)', async () => {
    const clientNonce = new Uint8Array(32).fill(1);
    const serverNonce = new Uint8Array(32).fill(2);
    const keys = await deriveChannelKeys('client', SECRET, clientNonce, serverNonce);
    const sealed = await createFrameSealer(keys.send, keys.sendDirection).seal(
      utf8Encode('merhaba')
    );

    const salt = Buffer.concat([clientNonce, serverNonce]);
    const nodeKey = Buffer.from(hkdfSync('sha256', SECRET, salt, REMOTE_KDF_INFO_C2S, 32));
    const header = Buffer.alloc(8);
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(REMOTE_DIRECTION_C2S, 0);
    const cipher = createCipheriv('aes-256-gcm', nodeKey, nonce);
    cipher.setAAD(header);
    const expected = Buffer.concat([
      cipher.update('merhaba', 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    expect(Buffer.from(sealed.subarray(0, 8))).toEqual(header);
    expect(Buffer.from(sealed.subarray(8))).toEqual(expected);
  });

  it('rejects replayed, reordered and tampered frames', async () => {
    const nonceA = new Uint8Array(nodeRandomBytes(32));
    const nonceB = new Uint8Array(nodeRandomBytes(32));
    const c = await deriveChannelKeys('client', SECRET, nonceA, nonceB);
    const s = await deriveChannelKeys('server', SECRET, nonceA, nonceB);
    const sealer = createFrameSealer(c.send, c.sendDirection);
    const f0 = await sealer.seal(utf8Encode('0'));
    const f1 = await sealer.seal(utf8Encode('1'));
    const f2 = await sealer.seal(utf8Encode('2'));

    const opener = createFrameOpener(s.receive, s.receiveDirection);
    await expect(opener.open(f1)).rejects.toThrow();
    expect(new TextDecoder().decode(await opener.open(f0))).toBe('0');
    await expect(opener.open(f0)).rejects.toThrow();
    const tampered = f1.slice();
    tampered[tampered.length - 1] ^= 1;
    await expect(opener.open(tampered)).rejects.toThrow();
    expect(new TextDecoder().decode(await opener.open(f1))).toBe('1');
    expect(new TextDecoder().decode(await opener.open(f2))).toBe('2');
  });

  it('does not accept a frame sent in the opposite direction (reflection)', async () => {
    const nonceA = new Uint8Array(nodeRandomBytes(32));
    const nonceB = new Uint8Array(nodeRandomBytes(32));
    const c = await deriveChannelKeys('client', SECRET, nonceA, nonceB);
    const frame = await createFrameSealer(c.send, c.sendDirection).seal(utf8Encode('x'));
    const reflected = createFrameOpener(c.receive, c.receiveDirection);
    await expect(reflected.open(frame)).rejects.toThrow();
  });
});

describe('handshake', () => {
  it('completes with the right secret and serves wire calls', async () => {
    const h = harness();
    const { promise } = connectClient(h);
    const transport = await promise;
    expect(transport.welcome.hostId).toBe('host-1');
    expect(transport.welcome.addresses).toEqual(['192.168.1.5']);
    expect(h.opened).toEqual([DEVICE_ID]);

    const api = client(contract, connect(transport));
    await expect(api.echo({ text: 'selam' })).resolves.toBe('echo:selam');
    transport.close?.();
  });

  it('rejects a wrong secret with AUTH_FAILED and counts the failure', async () => {
    const h = harness();
    const { promise } = connectClient(h, { secret: new Uint8Array(32).fill(9) });
    await expect(promise).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(h.rejected).toEqual(['auth-failed']);
    expect(h.opened).toEqual([]);
  });

  it('answers unknown and revoked devices exactly like a wrong secret', async () => {
    const h = harness();
    const unknown = connectClient(h, { deviceId: 'unknown-device-1' });
    await expect(unknown.promise).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    h.secrets.delete(DEVICE_ID);
    const revoked = connectClient(h);
    await expect(revoked.promise).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(h.opened).toEqual([]);
  });

  it('does not accept recorded client frames replayed on a new connection', async () => {
    const h = harness();
    const first = connectClient(h);
    const transport = await first.promise;
    const recorded = [...first.pair.recorded.fromClient];
    transport.close?.();
    expect(recorded.length).toBeGreaterThanOrEqual(2);

    // Saldırgan: kayıtlı hello + auth çerçevesini yeni bir bağlantıda oynatır.
    const pair = createMemorySocketPair();
    h.server.handleConnection(pair.server, '10.0.0.66');
    const closeInfo = new Promise<number>((resolve) =>
      pair.client.onClose((code) => resolve(code))
    );
    const received: unknown[] = [];
    pair.client.onMessage((data) => received.push(data));
    for (const frame of recorded) pair.client.send(frame);
    expect(await closeInfo).toBe(REMOTE_CLOSE.AUTH_FAILED);
    expect(received.every((item) => typeof item === 'string')).toBe(true);
    expect(h.opened).toEqual([DEVICE_ID]); // yalnızca ilk, meşru oturum
  });

  it('rate-limits repeated failures per address and recovers after the lock expires', async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      const attempt = connectClient(h, {
        deviceId: `unknown-device-${i}`,
        secret: new Uint8Array(32).fill(3),
        address: '10.0.0.50',
      });
      await expect(attempt.promise).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    }
    // Doğru sırla bile kilitli adres reddedilir.
    const blocked = connectClient(h, { address: '10.0.0.50' });
    const error = await blocked.promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteHandshakeError);
    expect(error).toMatchObject({ code: 'RATE_LIMITED' });
    expect(h.rejected.at(-1)).toBe('rate-limited');
    // Başka adres etkilenmez.
    const other = await connectClient(h, { address: '10.0.0.51' }).promise;
    other.close?.();

    h.clock.now += 31_000;
    const recovered = await connectClient(h, { address: '10.0.0.50' }).promise;
    recovered.close?.();
  });

  it('rate-limits by device id across addresses', async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      const attempt = connectClient(h, {
        secret: new Uint8Array(32).fill(3),
        address: `10.1.0.${i}`,
      });
      await expect(attempt.promise).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    }
    const blocked = connectClient(h, { address: '10.1.0.200' });
    await expect(blocked.promise).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('rejects an unsupported protocol version without processing further', async () => {
    const h = harness();
    const pair = createMemorySocketPair();
    h.server.handleConnection(pair.server, '10.0.0.7');
    const closed = new Promise<number>((resolve) => pair.client.onClose((code) => resolve(code)));
    pair.client.send(
      JSON.stringify({
        t: 'hello',
        v: 99,
        deviceId: DEVICE_ID,
        clientNonce: base64UrlEncode(new Uint8Array(32)),
      })
    );
    expect(await closed).toBe(REMOTE_CLOSE.VERSION_UNSUPPORTED);
  });

  it('closes handshakes that send garbage or oversized hello frames', async () => {
    const h = harness();
    for (const payload of [
      'not json',
      JSON.stringify({ t: 'hello', v: 1, deviceId: '!!', clientNonce: 'x' }),
      'x'.repeat(2000),
    ]) {
      const pair = createMemorySocketPair();
      h.server.handleConnection(pair.server, '10.0.0.8');
      const closed = new Promise<number>((resolve) => pair.client.onClose((code) => resolve(code)));
      pair.client.send(payload);
      expect(await closed).toBe(REMOTE_CLOSE.PROTOCOL);
    }
  });

  it('times out silent connections', async () => {
    const h = harness({ limits: { handshakeTimeoutMs: 30 } });
    const pair = createMemorySocketPair();
    h.server.handleConnection(pair.server, '10.0.0.9');
    const closed = new Promise<number>((resolve) => pair.client.onClose((code) => resolve(code)));
    expect(await closed).toBe(REMOTE_CLOSE.HANDSHAKE_TIMEOUT);
  });

  it('caps pending handshakes per address', async () => {
    const h = harness({ limits: { maxPendingPerAddress: 2 } });
    const sockets = [0, 1, 2].map(() => createMemorySocketPair());
    const codes: Array<number | undefined> = [];
    sockets.forEach((pair, index) => {
      pair.client.onClose((code) => (codes[index] = code));
      h.server.handleConnection(pair.server, '10.0.0.30');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(codes[2]).toBe(REMOTE_CLOSE.BUSY);
    expect(codes[0]).toBeUndefined();
    h.server.closeAll();
  });
});

describe('sessions', () => {
  it('closes an open connection immediately when the device is revoked', async () => {
    const h = harness();
    const transport = await connectClient(h).promise;
    const disconnected = new Promise<void>((resolve) => transport.onDisconnect(resolve));
    const closedInfo = new Promise<{ code: number }>((resolve) => transport.onClosed(resolve));
    expect(h.server.closeDevice(DEVICE_ID)).toBe(1);
    await disconnected;
    expect((await closedInfo).code).toBe(REMOTE_CLOSE.REVOKED);
    expect(h.closed).toEqual([DEVICE_ID]);
    expect(h.server.connectedDeviceIds()).toEqual([]);
  });

  it('replaces an older session of the same device', async () => {
    const h = harness();
    const first = await connectClient(h).promise;
    const firstClosed = new Promise<{ code: number }>((resolve) => first.onClosed(resolve));
    const second = await connectClient(h).promise;
    expect((await firstClosed).code).toBe(REMOTE_CLOSE.REPLACED);
    expect(h.server.connectedDeviceIds()).toEqual([DEVICE_ID]);
    second.close?.();
  });

  it('never carries blob channels or uploads', async () => {
    const h = harness();
    const transport = await connectClient(h).promise;
    expect(() => transport.post({ kind: 'blob-pull', channel: 'x', credit: 1 })).toThrow();
    expect(() =>
      transport.post({
        kind: 'call',
        id: '1',
        path: 'a.b',
        input: null,
        upload: { channel: 'c', meta: { name: 'f', mimeType: 'text/plain' } },
      })
    ).toThrow();
    const asPlain = (value: unknown) => utf8Encode(JSON.stringify(value));
    expect(
      decodeEnvelope(asPlain({ t: 'wire', m: { kind: 'blob-end', channel: 'x' } }))
    ).toBeNull();
    expect(
      decodeEnvelope(
        asPlain({
          t: 'wire',
          m: { kind: 'call', id: '1', path: 'a', input: null, upload: { channel: 'c', meta: {} } },
        })
      )
    ).toBeNull();
    expect(
      decodeEnvelope(asPlain({ t: 'wire', m: { kind: 'call', id: '1', path: 'a', input: 1 } }))
    ).not.toBeNull();
    expect(decodeEnvelope(asPlain({ t: 'nope' }))).toBeNull();
    transport.close?.();
  });

  it('answers app-level pings so idle clients stay connected', async () => {
    const h = harness();
    const pair = createMemorySocketPair();
    h.server.handleConnection(pair.server, '10.0.0.9');
    const transport = await connectRemoteTransport({
      url: 'ws://memory',
      deviceId: DEVICE_ID,
      secret: SECRET,
      createSocket: () => pair.client,
      pingIntervalMs: 20,
      idleTimeoutMs: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(h.server.connectedDeviceIds()).toEqual([DEVICE_ID]);
    transport.close?.();
  });
});

describe('web socket listener', () => {
  it('serves a wire call over a real loopback socket (random port)', async () => {
    const { listenRemoteServer } = await import('./node/ws-listener');
    const h = harness();
    const listener = await listenRemoteServer(h.server, { host: '127.0.0.1', port: 0 });
    try {
      const transport = await connectRemoteTransport({
        address: '127.0.0.1',
        port: listener.port,
        deviceId: DEVICE_ID,
        secret: SECRET,
        pingIntervalMs: 0,
        idleTimeoutMs: 0,
      });
      const api = client(contract, connect(transport));
      await expect(api.echo({ text: 'ağ' })).resolves.toBe('echo:ağ');

      const wrong = connectRemoteTransport({
        address: '127.0.0.1',
        port: listener.port,
        deviceId: DEVICE_ID,
        secret: new Uint8Array(32).fill(1),
        pingIntervalMs: 0,
        idleTimeoutMs: 0,
      });
      await expect(wrong).rejects.toMatchObject({ code: 'AUTH_FAILED' });

      const disconnected = new Promise<void>((resolve) => transport.onDisconnect(resolve));
      h.server.closeDevice(DEVICE_ID);
      await disconnected;
    } finally {
      await listener.close();
    }
  });
});
