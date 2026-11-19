import type { Secret } from '@orkestra/shared';
import { noopLogger } from '@orkestra/shared/logger';
import {
  base64UrlDecode,
  base64UrlEncode,
  createAccountPairingStore,
  createMemoryGistServer,
  deriveAccountPairingSecret,
  generateAccountPairingKeyPair,
  parseAccountPairingDocument,
  withAccountPairingRequest,
  type AccountPairingHttp,
  type AccountPairingRequest,
} from '@orkestra/wire/remote';
import type { RemoteListener, RemoteServer } from '@orkestra/wire/remote/node';
import { describe, expect, it } from 'vitest';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import {
  ACCOUNT_PAIRING_HOST_KEY_SECRET,
  AccountPairingCoordinator,
  ACCOUNT_PAIRING_MAX_BACKOFF_MS,
  ACCOUNT_PAIRING_POLL_MS,
} from './account-pairing-coordinator';
import {
  PAIRING_TTL_MS,
  RemoteAccessService,
  type StoredRemoteAccessState,
} from './remote-access-service';

const HOST_ID = 'host-aaaa-bbbb';
const TOKENS = {
  'token-alice-desktop': { account: 'alice' },
  'token-alice-phone': { account: 'alice' },
  'token-bob': { account: 'bob' },
  'token-alice-noscope': { account: 'alice', scopes: [] as string[] },
};

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

function setup(options: { account?: boolean } = {}) {
  const clock = { now: 5_000_000 };
  const secrets = new MemorySecrets();
  const gist = createMemoryGistServer(TOKENS);
  const net = { fail: false };
  const http: AccountPairingHttp = async (request) => {
    if (net.fail) throw new Error('offline');
    return gist.http(request);
  };
  const account = { token: 'token-alice-desktop', present: options.account ?? true };
  const interfaces = {
    en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
  } as Record<string, { address: string; family: string; internal: boolean }[]>;
  let persisted: StoredRemoteAccessState = {
    version: 1,
    hostId: HOST_ID,
    enabled: false,
    port: null,
    devices: [],
  };
  const service = new RemoteAccessService({
    persistence: {
      load: async () => structuredClone(persisted),
      save: async (state) => {
        persisted = structuredClone(state);
      },
    },
    secrets,
    logger: noopLogger,
    hostName: () => 'Ornek-Mac',
    networkInterfaces: () => interfaces as never,
    isSecureStorageAvailable: () => true,
    listen: async (_server: RemoteServer, listenOptions: { host: string; port: number }) =>
      ({ port: listenOptions.port || 50999, close: async () => {} }) satisfies RemoteListener,
    now: () => clock.now,
    pickPort: () => 50123,
  });
  const timer = {
    pending: null as { run: () => void; delay: number } | null,
    delays: [] as number[],
  };
  const coordinator = new AccountPairingCoordinator({
    host: service.accountPairingHost(),
    secrets,
    logger: noopLogger,
    getAccount: async () =>
      account.present
        ? {
            login: 'alice',
            accountId: 'acc-1',
            accessToken: account.token,
            apiBaseUrl: 'https://api.github.com',
          }
        : null,
    http,
    now: () => clock.now,
    scheduler: (run, delay) => {
      timer.pending = { run, delay };
      timer.delays.push(delay);
      return () => {
        if (timer.pending?.run === run) timer.pending = null;
      };
    },
  });
  service.attachAccountPairing(coordinator);

  /** Zamanlayıcıyı tetikler ve yoklamanın bitmesini bekler. */
  async function firePoll(): Promise<void> {
    const pending = timer.pending;
    if (!pending) throw new Error('no poll scheduled');
    timer.pending = null;
    clock.now += pending.delay;
    const before = coordinator.getStatus().lastCheckedAt;
    pending.run();
    await waitFor(() => coordinator.getStatus().lastCheckedAt !== before);
  }

  const phoneStore = createAccountPairingStore({
    getToken: () => 'token-alice-phone',
    http: gist.http,
  });
  async function phoneWrites(request: AccountPairingRequest) {
    const gistId = await phoneStore.find();
    if (!gistId) throw new Error('no document');
    return await phoneStore.update({
      gistId,
      change: (document) => withAccountPairingRequest(document, request),
      verify: (document) => document.requests.some((entry) => entry.deviceId === request.deviceId),
    });
  }
  const document = () => parseAccountPairingDocument(gist.contentOf('alice'))!;

  async function enableBoth() {
    await service.start({});
    expect((await service.setEnabled(true)).success).toBe(true);
    return await coordinator.setEnabled(true);
  }

  return {
    clock,
    secrets,
    gist,
    net,
    account,
    interfaces,
    service,
    coordinator,
    timer,
    firePoll,
    phoneWrites,
    document,
    enableBoth,
    persisted: () => persisted,
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('timed out');
}

async function makeRequest(
  ctx: ReturnType<typeof setup>,
  overrides: Partial<AccountPairingRequest> = {}
) {
  const host = ctx.document().hosts[0]!;
  const keys = await generateAccountPairingKeyPair();
  const request: AccountPairingRequest = {
    deviceId: 'phone-device-1',
    hostId: HOST_ID,
    name: 'Pixel 9',
    platform: 'android',
    publicKey: keys.publicKey,
    createdAt: ctx.clock.now,
    ...overrides,
  };
  return { request, keys, host };
}

const pendingIds = async (ctx: ReturnType<typeof setup>) =>
  (await ctx.service.getState()).devices.map((device) => device.id);

describe('AccountPairingCoordinator', () => {
  it('publishes this host to a new private document when enabled', async () => {
    const ctx = setup();
    const result = await ctx.enableBoth();
    expect(result).toMatchObject({ success: true, data: { enabled: true, status: 'active' } });
    const host = ctx.document().hosts[0]!;
    expect(host).toMatchObject({
      id: HOST_ID,
      name: 'Ornek-Mac',
      addresses: ['192.168.1.20'],
      port: 50123,
      publicKey: ctx.persisted().accountPairing?.publicKey,
    });
    expect(ctx.persisted().accountPairing).toMatchObject({ enabled: true });
    expect(ctx.persisted().accountPairing?.gistId).toMatch(/^[0-9a-f]+$/);
    expect(ctx.coordinator.getStatus()).toMatchObject({ login: 'alice' });
    // Özel anahtar yalnızca sır deposunda; kalıcı durumda ve belgede yok.
    expect(ctx.secrets.values.has(ACCOUNT_PAIRING_HOST_KEY_SECRET)).toBe(true);
    const privateKey = ctx.secrets.values.get(ACCOUNT_PAIRING_HOST_KEY_SECRET)!.expose();
    const d = (JSON.parse(privateKey) as { d: string }).d;
    expect(JSON.stringify(ctx.persisted())).not.toContain(d);
    expect(ctx.gist.contentOf('alice')).not.toContain(d);
    expect(ctx.timer.pending?.delay).toBe(ACCOUNT_PAIRING_POLL_MS);
  });

  it('turns a valid request into a pending device with the secret the phone derives', async () => {
    const ctx = setup();
    await ctx.enableBoth();
    const { request, keys, host } = await makeRequest(ctx);
    await ctx.phoneWrites(request);
    await ctx.firePoll();

    const phoneSecret = await deriveAccountPairingSecret({
      role: 'device',
      privateKey: keys.privateKey,
      ownPublicKey: keys.publicKey,
      peerPublicKey: host.publicKey,
      hostId: HOST_ID,
      deviceId: request.deviceId,
    });
    const stored = ctx.secrets.values.get(`remoteAccess.device.${request.deviceId}`)!;
    expect(base64UrlDecode(stored.expose())).toEqual(phoneSecret);
    const device = (await ctx.service.getState()).devices[0]!;
    expect(device).toMatchObject({
      id: request.deviceId,
      status: 'pending',
      expiresAt: ctx.clock.now + PAIRING_TTL_MS,
    });
    expect(ctx.document().requests).toEqual([]);
    expect(ctx.coordinator.getStatus().lastPairedDeviceName).toBe('Pixel 9');
    // Sır belgeye ya da kalıcı duruma yazılmadı.
    expect(ctx.gist.contentOf('alice')).not.toContain(base64UrlEncode(phoneSecret));
    expect(JSON.stringify(ctx.persisted())).not.toContain(base64UrlEncode(phoneSecret));
  });

  it('removes an expired request without registering it', async () => {
    const ctx = setup();
    await ctx.enableBoth();
    const { request } = await makeRequest(ctx, { createdAt: ctx.clock.now - 11 * 60_000 });
    await ctx.phoneWrites(request);
    await ctx.firePoll();
    expect(await pendingIds(ctx)).toEqual([]);
    expect(ctx.document().requests).toEqual([]);
  });

  it('leaves a request addressed to another host untouched', async () => {
    const ctx = setup();
    await ctx.enableBoth();
    const { request } = await makeRequest(ctx, { hostId: 'some-other-host' });
    await ctx.phoneWrites(request);
    await ctx.firePoll();
    expect(await pendingIds(ctx)).toEqual([]);
    expect(ctx.document().requests.map((entry) => entry.deviceId)).toEqual([request.deviceId]);
  });

  it('does not register a duplicate device id twice and still clears the request', async () => {
    const ctx = setup();
    await ctx.enableBoth();
    const first = await makeRequest(ctx);
    await ctx.phoneWrites(first.request);
    await ctx.firePoll();
    const stored = ctx.secrets.values.get(`remoteAccess.device.${first.request.deviceId}`)!;
    const before = stored.expose();

    const again = await makeRequest(ctx, { createdAt: ctx.clock.now + 1 });
    await ctx.phoneWrites(again.request);
    await ctx.firePoll();
    expect(await pendingIds(ctx)).toEqual([first.request.deviceId]);
    expect(ctx.secrets.values.get(`remoteAccess.device.${first.request.deviceId}`)!.expose()).toBe(
      before
    );
    expect(ctx.document().requests).toEqual([]);
  });

  it('rejects a request with a bad key without stopping the next one', async () => {
    const ctx = setup();
    await ctx.enableBoth();
    // Biçimi geçerli (0x04 ‖ 64 bayt) ama eğri üzerinde olmayan nokta.
    const offCurve = base64UrlEncode(new Uint8Array([0x04, ...new Array(64).fill(1)]));
    const bad = await makeRequest(ctx, {
      deviceId: 'phone-bad-key',
      publicKey: offCurve,
      createdAt: ctx.clock.now + 5,
    });
    const good = await makeRequest(ctx, { deviceId: 'phone-good-key' });
    await ctx.phoneWrites(bad.request);
    await ctx.phoneWrites(good.request);
    await ctx.firePoll();
    expect(await pendingIds(ctx)).toEqual(['phone-good-key']);
    expect(ctx.document().requests).toEqual([]);
  });

  it('stops polling on missing-scope and unauthorized until the user checks again', async () => {
    const noScope = setup();
    noScope.account.token = 'token-alice-noscope';
    await noScope.enableBoth();
    expect(noScope.coordinator.getStatus()).toMatchObject({ status: 'missing-scope' });
    expect(noScope.timer.pending).toBeNull();
    const calls = noScope.gist.log.length;
    await noScope.coordinator.checkNow();
    expect(noScope.gist.log.length).toBeGreaterThan(calls); // "Şimdi kontrol et" yeniden dener
    expect(noScope.coordinator.getStatus().status).toBe('missing-scope');
    expect(noScope.timer.pending).toBeNull();
    // Hesap düzelince "Şimdi kontrol et" toparlar.
    noScope.account.token = 'token-alice-desktop';
    await noScope.coordinator.checkNow();
    expect(noScope.coordinator.getStatus().status).toBe('active');
    expect(noScope.timer.pending).not.toBeNull();

    const expired = setup();
    await expired.enableBoth();
    expired.account.token = 'revoked-token';
    await expired.firePoll();
    expect(expired.coordinator.getStatus().status).toBe('unauthorized');
    expect(expired.timer.pending).toBeNull();
  });

  it('reports no-account without touching the network', async () => {
    const ctx = setup({ account: false });
    await ctx.enableBoth();
    expect(ctx.coordinator.getStatus()).toMatchObject({ enabled: true, status: 'no-account' });
    expect(ctx.gist.log).toEqual([]);
  });

  it('waits for remote access and withdraws the entry when it is switched off', async () => {
    const ctx = setup();
    await ctx.service.start({});
    // Mobil erişim kapalı: ayar açılır ama yayın yapılmaz.
    expect((await ctx.coordinator.setEnabled(true)).success).toBe(true);
    expect(ctx.coordinator.getStatus().status).toBe('waiting-remote-access');
    expect(ctx.gist.log).toEqual([]);
    expect(ctx.timer.pending).toBeNull();

    await ctx.service.setEnabled(true);
    await waitFor(() => ctx.coordinator.getStatus().status === 'active');
    expect(ctx.document().hosts).toHaveLength(1);

    await ctx.service.setEnabled(false);
    await waitFor(() => ctx.coordinator.getStatus().status === 'waiting-remote-access');
    expect(ctx.document().hosts).toEqual([]);
    expect(ctx.timer.pending).toBeNull();
    // Ayar açık kalır; anahtar korunur.
    expect(ctx.persisted().accountPairing?.enabled).toBe(true);
    expect(ctx.secrets.values.has(ACCOUNT_PAIRING_HOST_KEY_SECRET)).toBe(true);
  });

  it('uses a conditional request and writes nothing when the document is unchanged', async () => {
    const ctx = setup();
    await ctx.enableBoth();
    ctx.gist.log.length = 0;
    await ctx.firePoll();
    await ctx.firePoll();
    expect(ctx.gist.log).toEqual([
      { method: 'GET', path: expect.stringMatching(/^\/gists\/[0-9a-f]+$/), status: 304 },
      { method: 'GET', path: expect.stringMatching(/^\/gists\/[0-9a-f]+$/), status: 304 },
    ]);
  });

  it('republishes when the addresses change and when the document was wiped', async () => {
    const ctx = setup();
    await ctx.enableBoth();
    ctx.interfaces.en0 = [{ address: '192.168.1.99', family: 'IPv4', internal: false }];
    await ctx.firePoll();
    expect(ctx.document().hosts[0]!.addresses).toEqual(['192.168.1.99']);

    ctx.gist.overwrite('alice', '{}');
    await ctx.firePoll();
    expect(ctx.document().hosts[0]).toMatchObject({ id: HOST_ID, addresses: ['192.168.1.99'] });
  });

  it('backs off on network errors, doubling up to the cap, and resets on success', async () => {
    const ctx = setup();
    await ctx.enableBoth();
    ctx.net.fail = true;
    await ctx.firePoll();
    expect(ctx.coordinator.getStatus().status).toBe('error');
    expect(ctx.timer.pending?.delay).toBe(ACCOUNT_PAIRING_POLL_MS * 2);
    await ctx.firePoll();
    expect(ctx.timer.pending?.delay).toBe(ACCOUNT_PAIRING_POLL_MS * 4);
    for (let i = 0; i < 6; i += 1) await ctx.firePoll();
    expect(ctx.timer.pending?.delay).toBe(ACCOUNT_PAIRING_MAX_BACKOFF_MS);
    ctx.net.fail = false;
    await ctx.firePoll();
    expect(ctx.coordinator.getStatus().status).toBe('active');
    expect(ctx.timer.pending?.delay).toBe(ACCOUNT_PAIRING_POLL_MS);
  });

  it('disabling removes the host entry, deletes the private key and clears the settings', async () => {
    const ctx = setup();
    await ctx.enableBoth();
    const result = await ctx.coordinator.setEnabled(false);
    expect(result).toMatchObject({ success: true, data: { enabled: false, status: 'off' } });
    expect(ctx.document().hosts).toEqual([]);
    expect(ctx.secrets.values.has(ACCOUNT_PAIRING_HOST_KEY_SECRET)).toBe(false);
    expect(ctx.persisted().accountPairing).toEqual({
      enabled: false,
      gistId: null,
      publicKey: null,
    });
    expect(ctx.timer.pending).toBeNull();
  });

  it('does not create a document when disabling while none exists', async () => {
    const ctx = setup();
    await ctx.service.start({});
    await ctx.service.setEnabled(true);
    await ctx.coordinator.setEnabled(false);
    expect(ctx.gist.contentOf('alice')).toBeNull();
    expect(ctx.gist.log).toEqual([]);
  });

  it("another account's token cannot inject a request", async () => {
    const ctx = setup();
    await ctx.enableBoth();
    const { request } = await makeRequest(ctx);
    const attacker = createAccountPairingStore({
      getToken: () => 'token-bob',
      http: ctx.gist.http,
    });
    const gistId = ctx.persisted().accountPairing!.gistId!;
    const result = await attacker.update({
      gistId,
      change: (doc) => withAccountPairingRequest(doc, request),
      verify: (doc) => doc.requests.length > 0,
    });
    expect(result).toBeNull();
    await ctx.firePoll();
    expect(ctx.document().requests).toEqual([]);
    expect(await pendingIds(ctx)).toEqual([]);
  });

  it('keeps timers unref-able and stops scheduling after dispose', async () => {
    const ctx = setup();
    await ctx.enableBoth();
    ctx.coordinator.dispose();
    expect(ctx.timer.pending).toBeNull();
    ctx.coordinator.notifyHostChanged();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ctx.timer.pending).toBeNull();
  });
});
