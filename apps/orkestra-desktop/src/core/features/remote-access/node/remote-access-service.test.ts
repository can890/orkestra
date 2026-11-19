import type { Secret } from '@orkestra/shared';
import { noopLogger } from '@orkestra/shared/logger';
import {
  base64UrlDecode,
  connectRemoteTransport,
  createMemorySocketPair,
  type RemoteClientTransport,
} from '@orkestra/wire/remote';
import type { RemoteListener, RemoteServer } from '@orkestra/wire/remote/node';
import {
  client,
  connect,
  createController,
  defineContract,
  procedure,
  type Controller,
} from '@orkestra/wire/rpc';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import { parsePairingPayload } from '../api/pairing-payload';
import {
  MAX_DEVICES,
  MAX_PENDING_PAIRINGS,
  PAIRING_TTL_MS,
  RemoteAccessService,
  type StoredRemoteAccessState,
} from './remote-access-service';

const conversationsContract = defineContract({
  getConversations: procedure({ input: z.void(), output: z.array(z.string()) }),
});
const sshContract = defineContract({ list: procedure({ input: z.void(), output: z.string() }) });
const consumerContract = defineContract({
  conversations: conversationsContract,
  ssh: sshContract,
});

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, Secret<string>>();
  async getSecret(key: string) {
    return this.values.get(key) ?? null;
  }
  async setSecret(key: string, value: Secret<string>) {
    this.values.set(key, value);
  }
  async deleteSecret(key: string) {
    this.values.delete(key);
  }
}

function setup(options: { enabledAtBoot?: boolean; secureStorage?: boolean } = {}) {
  const clock = { now: 5_000_000 };
  const secrets = new MemorySecrets();
  let persisted: StoredRemoteAccessState | null = options.enabledAtBoot
    ? { version: 1, hostId: 'host-aaaa-bbbb', enabled: true, port: 50123, devices: [] }
    : null;
  const saves = vi.fn();
  let captured: RemoteServer | undefined;
  const closeListener = vi.fn(async () => {});
  const listen = vi.fn(
    async (server: RemoteServer, listenOptions: { host: string; port: number }) => {
      captured = server;
      const listener: RemoteListener = { port: listenOptions.port || 50999, close: closeListener };
      return listener;
    }
  );
  const sshCall = vi.fn(async () => 'ssh-secret-data');
  const controllers: Record<string, Controller> = {
    conversations: createController(conversationsContract, {
      getConversations: () => ['c1', 'c2'],
    }),
    ssh: createController(sshContract, { list: sshCall }),
  };
  const service = new RemoteAccessService({
    persistence: {
      load: async () => (persisted ? structuredClone(persisted) : null),
      save: async (state) => {
        persisted = structuredClone(state);
        saves(state);
      },
    },
    secrets,
    logger: noopLogger,
    hostName: () => 'Ornek-Mac',
    networkInterfaces: () => ({
      en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    }),
    isSecureStorageAvailable: () => options.secureStorage ?? true,
    listen,
    now: () => clock.now,
    pickPort: () => 50123,
  });
  return {
    service,
    controllers,
    secrets,
    listen,
    closeListener,
    sshCall,
    clock,
    server: () => captured!,
    persisted: () => persisted,
  };
}

async function pairPhone(
  ctx: ReturnType<typeof setup>,
  payloadText: string,
  address = '10.0.0.2'
): Promise<RemoteClientTransport> {
  const payload = parsePairingPayload(payloadText)!;
  const pair = createMemorySocketPair();
  ctx.server().handleConnection(pair.server, address);
  return await connectRemoteTransport({
    url: 'ws://memory',
    deviceId: payload.d,
    secret: base64UrlDecode(payload.s)!,
    clientName: 'Pixel 9',
    platform: 'android',
    createSocket: () => pair.client,
    pingIntervalMs: 0,
    idleTimeoutMs: 0,
  });
}

describe('RemoteAccessService', () => {
  it('is off by default: starting the app opens no port', async () => {
    const ctx = setup();
    await ctx.service.start(ctx.controllers);
    expect(ctx.listen).not.toHaveBeenCalled();
    const state = await ctx.service.getState();
    expect(state).toMatchObject({ enabled: false, listening: false, devices: [] });
  });

  it('listens on boot only when the setting was enabled before', async () => {
    const ctx = setup({ enabledAtBoot: true });
    await ctx.service.start(ctx.controllers);
    expect(ctx.listen).toHaveBeenCalledTimes(1);
    expect(ctx.listen.mock.calls[0]![1]).toEqual({ host: '0.0.0.0', port: 50123 });
    expect(await ctx.service.getState()).toMatchObject({
      enabled: true,
      listening: true,
      port: 50123,
    });
  });

  it('refuses to enable without secure secret storage', async () => {
    const ctx = setup({ secureStorage: false });
    await ctx.service.start(ctx.controllers);
    const result = await ctx.service.setEnabled(true);
    expect(result).toMatchObject({ success: false, error: { type: 'storage-unavailable' } });
    expect(ctx.listen).not.toHaveBeenCalled();
  });

  it('pairs a phone with the QR payload and lists chats end to end', async () => {
    const ctx = setup();
    await ctx.service.start(ctx.controllers);
    const enabled = await ctx.service.setEnabled(true);
    expect(enabled.success && enabled.data).toMatchObject({ enabled: true, listening: true });

    const pairing = await ctx.service.createPairing();
    if (!pairing.success) throw new Error('pairing failed');
    const payload = parsePairingPayload(pairing.data.payload)!;
    expect(payload).toMatchObject({
      k: 'orkestra-pair',
      v: 1,
      n: 'Ornek-Mac',
      a: ['192.168.1.20'],
      p: 50123,
    });
    expect(base64UrlDecode(payload.s)!.byteLength).toBe(32);
    expect(pairing.data.expiresAt).toBe(ctx.clock.now + PAIRING_TTL_MS);
    expect((await ctx.service.getState()).devices[0]).toMatchObject({ status: 'pending' });

    const transport = await pairPhone(ctx, pairing.data.payload);
    expect(transport.welcome).toMatchObject({
      hostId: expect.any(String),
      hostName: 'Ornek-Mac',
      port: 50123,
      addresses: ['192.168.1.20'],
    });

    const api = client(consumerContract, connect(transport));
    await expect(api.conversations.getConversations()).resolves.toEqual(['c1', 'c2']);

    // Eşleşme tamamlandı: cihaz "paired" ve bağlı.
    await vi.waitFor(async () => {
      const device = (await ctx.service.getState()).devices[0]!;
      expect(device).toMatchObject({
        status: 'paired',
        name: 'Pixel 9',
        platform: 'android',
        connected: true,
        expiresAt: null,
      });
    });

    // İzin listesi dışı: SSH'a ulaşılamaz ve alttaki denetleyici çağrılmaz.
    await expect(api.ssh.list()).rejects.toMatchObject({ code: 'UNKNOWN_PROCEDURE' });
    expect(ctx.sshCall).not.toHaveBeenCalled();
    transport.close?.();
  });

  it('never persists or exposes the secret outside the secret store and the QR payload', async () => {
    const ctx = setup();
    await ctx.service.start(ctx.controllers);
    await ctx.service.setEnabled(true);
    const pairing = await ctx.service.createPairing();
    if (!pairing.success) throw new Error('pairing failed');
    const payload = parsePairingPayload(pairing.data.payload)!;
    expect(JSON.stringify(ctx.persisted())).not.toContain(payload.s);
    expect(JSON.stringify(await ctx.service.getState())).not.toContain(payload.s);
    const stored = ctx.secrets.values.get(`remoteAccess.device.${payload.d}`)!;
    expect(stored.expose()).toBe(payload.s);
    expect(String(stored)).not.toContain(payload.s);
  });

  it('revokes a device: its open connection closes immediately and it cannot reconnect', async () => {
    const ctx = setup();
    await ctx.service.start(ctx.controllers);
    await ctx.service.setEnabled(true);
    const pairing = await ctx.service.createPairing();
    if (!pairing.success) throw new Error('pairing failed');
    const transport = await pairPhone(ctx, pairing.data.payload);
    const closed = new Promise<{ code: number }>((resolve) => transport.onClosed(resolve));

    expect(await ctx.service.revokeDevice(pairing.data.deviceId)).toMatchObject({ success: true });
    expect((await closed).code).toBe(4403);
    expect((await ctx.service.getState()).devices).toEqual([]);
    expect(ctx.secrets.values.size).toBe(0);
    await expect(pairPhone(ctx, pairing.data.payload)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    expect(await ctx.service.revokeDevice(pairing.data.deviceId)).toMatchObject({
      success: false,
      error: { type: 'not-found' },
    });
  });

  it('expires unclaimed pairings', async () => {
    const ctx = setup();
    await ctx.service.start(ctx.controllers);
    await ctx.service.setEnabled(true);
    const pairing = await ctx.service.createPairing();
    if (!pairing.success) throw new Error('pairing failed');
    ctx.clock.now += PAIRING_TTL_MS + 1;
    await expect(pairPhone(ctx, pairing.data.payload)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    expect((await ctx.service.getState()).devices).toEqual([]);
    expect(ctx.secrets.values.size).toBe(0);
  });

  it('cancels pending pairings only, and caps pending/total devices', async () => {
    const ctx = setup();
    await ctx.service.start(ctx.controllers);
    expect(await ctx.service.createPairing()).toMatchObject({
      success: false,
      error: { type: 'not-enabled' },
    });
    await ctx.service.setEnabled(true);

    const first = await ctx.service.createPairing();
    if (!first.success) throw new Error('pairing failed');
    expect(await ctx.service.cancelPairing(first.data.deviceId)).toMatchObject({ success: true });
    expect(await ctx.service.cancelPairing(first.data.deviceId)).toMatchObject({ success: false });

    const ids: string[] = [];
    for (let i = 0; i < MAX_PENDING_PAIRINGS + 2; i += 1) {
      const next = await ctx.service.createPairing();
      if (!next.success) throw new Error('pairing failed');
      ids.push(next.data.deviceId);
    }
    const state = await ctx.service.getState();
    expect(state.devices.length).toBe(MAX_PENDING_PAIRINGS);
    expect(state.devices.map((d) => d.id)).toEqual(ids.slice(-MAX_PENDING_PAIRINGS));

    // Paired cihaz cancelPairing ile silinemez.
    const lastId = ids.at(-1)!;
    const lastSecret = ctx.secrets.values.get(`remoteAccess.device.${lastId}`)!.expose();
    const transport = await pairPhone(
      ctx,
      JSON.stringify({
        k: 'orkestra-pair',
        v: 1,
        h: 'host',
        n: 'Mac',
        a: [],
        p: 1,
        d: lastId,
        s: lastSecret,
      })
    );
    await vi.waitFor(async () =>
      expect((await ctx.service.getState()).devices.at(-1)!.status).toBe('paired')
    );
    expect(await ctx.service.cancelPairing(ids.at(-1)!)).toMatchObject({
      success: false,
      error: { type: 'not-found' },
    });
    transport.close?.();
    expect(MAX_DEVICES).toBeGreaterThan(MAX_PENDING_PAIRINGS);
  });

  it('disabling closes the listener, drops pending pairings and ends sessions', async () => {
    const ctx = setup();
    await ctx.service.start(ctx.controllers);
    await ctx.service.setEnabled(true);
    const pairing = await ctx.service.createPairing();
    if (!pairing.success) throw new Error('pairing failed');
    const transport = await pairPhone(ctx, pairing.data.payload);
    await vi.waitFor(async () =>
      expect((await ctx.service.getState()).devices[0]!.status).toBe('paired')
    );
    await ctx.service.createPairing();

    const disabled = await ctx.service.setEnabled(false);
    expect(disabled.success && disabled.data).toMatchObject({ enabled: false, listening: false });
    expect(ctx.closeListener).toHaveBeenCalledTimes(1);
    // Eşleşmiş cihaz kalır, bekleyen eşleştirme silinir.
    const devices = (await ctx.service.getState()).devices;
    expect(devices.map((d) => d.status)).toEqual(['paired']);
    expect(ctx.persisted()?.enabled).toBe(false);
    transport.close?.();
  });

  it('retries another port when the chosen one is taken and remembers it', async () => {
    const ctx = setup();
    let attempts = 0;
    ctx.listen.mockImplementation(async (_server, options) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' });
      return { port: options.port, close: ctx.closeListener };
    });
    await ctx.service.start(ctx.controllers);
    const result = await ctx.service.setEnabled(true);
    expect(result.success).toBe(true);
    expect(attempts).toBe(2);
    expect(ctx.persisted()?.port).toBe(50123);

    const failing = setup();
    failing.listen.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await failing.service.start(failing.controllers);
    expect(await failing.service.setEnabled(true)).toMatchObject({
      success: false,
      error: { type: 'listen-failed' },
    });
    expect((await failing.service.getState()).enabled).toBe(false);
  });
});
