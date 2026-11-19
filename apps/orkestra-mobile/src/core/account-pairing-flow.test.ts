import {
  AccountPairingStoreError,
  createAccountPairingStore,
  createMemoryGistServer,
  generateAccountPairingKeyPair,
  parseAccountPairingDocument,
  withAccountPairingHost,
} from '@orkestra/wire/remote';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeAccountDesktop, type FakeAccountDesktop } from '../testing/fake-account-desktop';
import {
  describeStoreError,
  discoverHosts,
  NO_HOST_MESSAGE,
  pairWithHost,
  TIMEOUT_MESSAGE,
} from './account-pairing-flow';
import { AppSession } from './app-session';
import { createConnectionManager } from './connection-manager';
import { createMemorySecureStore, createPairingRepository } from './pairing-store';

const TOKEN = 'gho_phone_token_secret';
const OTHER_TOKEN = 'gho_other_account_token';
const HOST_ID = 'host-acct-0001';

function setup() {
  const gist = createMemoryGistServer({
    [TOKEN]: { account: 'ben' },
    [OTHER_TOKEN]: { account: 'baskasi' },
  });
  const phoneStore = createAccountPairingStore({ getToken: () => TOKEN, http: gist.http });
  const secureStore = createMemorySecureStore();
  const repository = createPairingRepository(secureStore);
  const session = new AppSession({
    repository,
    clientName: 'Test telefon',
    platform: 'android',
    createManager: (options) =>
      createConnectionManager({
        ...options,
        backoffMs: [20, 40],
        handshakeTimeoutMs: 2000,
        pingIntervalMs: 0,
        idleTimeoutMs: 0,
      }),
  });
  return { gist, phoneStore, secureStore, repository, session };
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > 4000) throw new Error(`Zaman aşımı: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('hesap üzerinden eşleşme akışı', () => {
  const desktops: FakeAccountDesktop[] = [];
  let session: AppSession | undefined;
  afterEach(async () => {
    const state = session?.getState();
    if (state?.phase === 'paired') state.manager.stop();
    session = undefined;
    for (const desktop of desktops.splice(0)) await desktop.close();
  });

  async function desktop(
    gist: ReturnType<typeof setup>['gist'],
    hostId = HOST_ID,
    name = 'Test Mac'
  ) {
    const fake = await createFakeAccountDesktop({ gist, token: TOKEN, hostId, name });
    desktops.push(fake);
    await fake.publish();
    return fake;
  }

  it('tek masaüstü: istek yazılır, onaylanınca eşleşir, kayıt saklanır ve bağlantı çalışır', async () => {
    const ctx = setup();
    session = ctx.session;
    await session.init();
    const fake = await desktop(ctx.gist);

    const found = await discoverHosts(ctx.phoneStore);
    if (found.kind !== 'ready') throw new Error('ready bekleniyordu');
    expect(found.hosts.map((host) => host.id)).toEqual([HOST_ID]);

    let waiting = false;
    const pairing = pairWithHost({
      store: ctx.phoneStore,
      gistId: found.gistId,
      host: found.hosts[0]!,
      pair: (payload) => session!.pair(payload),
      deviceName: 'Pixel',
      platform: 'android',
      signal: new AbortController().signal,
      onWaiting: () => (waiting = true),
      retryMs: 20,
    });

    // Masaüstü isteği görmeden önce el sıkışma reddedilir; akış beklemeye devam eder.
    await waitFor(() => waiting, 'bekleme');
    await waitFor(async () => {
      const read = await fake.store.read(found.gistId);
      return read.status === 'ok' && read.document.requests.length === 1;
    }, 'istek belgede');
    const read = await fake.store.read(found.gistId);
    if (read.status !== 'ok') throw new Error('belge');
    expect(read.document.requests[0]).toMatchObject({
      hostId: HOST_ID,
      name: 'Pixel',
      platform: 'android',
    });
    expect(fake.knownDevices()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(session.getState().phase).toBe('unpaired');

    const approved = await fake.approvePending();
    expect(approved).toHaveLength(1);
    expect(await pairing).toEqual({ kind: 'paired' });

    const saved = await ctx.repository.load();
    expect(saved).toMatchObject({
      hostId: HOST_ID,
      hostName: 'Test Mac',
      addresses: ['127.0.0.1'],
      port: fake.port,
      deviceId: approved[0],
    });
    expect(saved?.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const state = session.getState();
    if (state.phase !== 'paired') throw new Error('paired bekleniyordu');
    await waitFor(() => state.manager.status().kind === 'connected', 'kalıcı bağlantı');

    // Belgede istek kalmaz, belgede özel anahtar/sır yoktur.
    const content = ctx.gist.contentOf('ben')!;
    expect(parseAccountPairingDocument(content)?.requests).toEqual([]);
    expect(content).not.toContain(saved!.secret);
    expect(content).not.toContain(TOKEN);
  });

  it('birden çok masaüstünde liste döner (en yeni önce)', async () => {
    const ctx = setup();
    await desktop(ctx.gist, 'host-acct-0001', 'Ev Mac');
    const second = await createFakeAccountDesktop({
      gist: ctx.gist,
      token: TOKEN,
      hostId: 'host-acct-0002',
      name: 'Ofis',
    });
    desktops.push(second);
    await second.publish();
    const found = await discoverHosts(ctx.phoneStore);
    if (found.kind !== 'ready') throw new Error('ready bekleniyordu');
    expect(found.hosts.map((host) => host.name).sort()).toEqual(['Ev Mac', 'Ofis']);
    expect(found.hosts[0]!.updatedAt).toBeGreaterThanOrEqual(found.hosts[1]!.updatedAt);
  });

  it('belge yoksa ya da masaüstü kaydı yoksa no-host', async () => {
    const ctx = setup();
    expect(await discoverHosts(ctx.phoneStore)).toEqual({
      kind: 'no-host',
      message: NO_HOST_MESSAGE,
    });

    // Belge var ama masaüstü kaydı yok.
    const keys = await generateAccountPairingKeyPair();
    await ctx.phoneStore.update({
      gistId: null,
      create: true,
      change: (document) =>
        withAccountPairingHost(document, {
          id: HOST_ID,
          name: 'x',
          addresses: ['127.0.0.1'],
          port: 1,
          publicKey: keys.publicKey,
          updatedAt: 1,
        }),
      verify: () => true,
    });
    ctx.gist.overwrite(
      'ben',
      JSON.stringify({ k: 'orkestra-account-pairing', v: 1, hosts: [], requests: [] })
    );
    expect(await discoverHosts(ctx.phoneStore)).toEqual({
      kind: 'no-host',
      message: NO_HOST_MESSAGE,
    });
  });

  it('başka hesabın belirteci belgeyi görmez', async () => {
    const ctx = setup();
    await desktop(ctx.gist);
    const other = createAccountPairingStore({ getToken: () => OTHER_TOKEN, http: ctx.gist.http });
    expect(await discoverHosts(other)).toEqual({ kind: 'no-host', message: NO_HOST_MESSAGE });
  });

  it('masaüstü yanıt vermezse zaman aşımı iletisi döner ve istek belgeden silinir', async () => {
    const ctx = setup();
    session = ctx.session;
    await session.init();
    const fake = await desktop(ctx.gist);
    const found = await discoverHosts(ctx.phoneStore);
    if (found.kind !== 'ready') throw new Error('ready bekleniyordu');
    const result = await pairWithHost({
      store: ctx.phoneStore,
      gistId: found.gistId,
      host: found.hosts[0]!,
      pair: (payload) => session!.pair(payload),
      deviceName: 'Pixel',
      platform: 'android',
      signal: new AbortController().signal,
      retryMs: 20,
      fallbackDialMs: 100,
      waitMs: 300,
    });
    expect(result).toEqual({ kind: 'timeout', message: TIMEOUT_MESSAGE });
    const read = await fake.store.read(found.gistId);
    expect(read.status === 'ok' && read.document.requests).toEqual([]);
    expect(await ctx.repository.load()).toBeNull();
    expect(session.getState().phase).toBe('unpaired');
  });

  it('masaüstü isteği belgeden silmese de seyrek denemeyle bağlanır', async () => {
    const ctx = setup();
    session = ctx.session;
    await session.init();
    const fake = await desktop(ctx.gist);
    const found = await discoverHosts(ctx.phoneStore);
    if (found.kind !== 'ready') throw new Error('ready bekleniyordu');
    const pairing = pairWithHost({
      store: ctx.phoneStore,
      gistId: found.gistId,
      host: found.hosts[0]!,
      pair: (payload) => session!.pair(payload),
      deviceName: 'Pixel',
      platform: 'android',
      signal: new AbortController().signal,
      retryMs: 20,
      fallbackDialMs: 100,
    });
    await waitFor(
      async () => (await fake.approvePending({ removeRequests: false })).length > 0,
      'istek'
    );
    expect(await pairing).toEqual({ kind: 'paired' });
  });

  it('iptal edilince durur ve isteği siler', async () => {
    const ctx = setup();
    session = ctx.session;
    await session.init();
    const fake = await desktop(ctx.gist);
    const found = await discoverHosts(ctx.phoneStore);
    if (found.kind !== 'ready') throw new Error('ready bekleniyordu');
    const controller = new AbortController();
    const pairing = pairWithHost({
      store: ctx.phoneStore,
      gistId: found.gistId,
      host: found.hosts[0]!,
      pair: (payload) => session!.pair(payload),
      deviceName: 'Pixel',
      platform: 'android',
      signal: controller.signal,
      onWaiting: () => setTimeout(() => controller.abort(), 50),
      retryMs: 20,
    });
    expect(await pairing).toEqual({ kind: 'cancelled' });
    const read = await fake.store.read(found.gistId);
    expect(read.status === 'ok' && read.document.requests).toEqual([]);
  });

  it('izin eksikse ve oturum geçersizse Türkçe ileti verir', async () => {
    const gist = createMemoryGistServer({
      [TOKEN]: { account: 'ben', scopes: ['repo'] },
    });
    const noScope = createAccountPairingStore({ getToken: () => TOKEN, http: gist.http });
    expect(await discoverHosts(noScope)).toEqual({
      kind: 'error',
      message: 'GitHub izni eksik; yeniden giriş yapın.',
    });
    const badToken = createAccountPairingStore({ getToken: () => 'yanlis', http: gist.http });
    expect(await discoverHosts(badToken)).toEqual({
      kind: 'error',
      message: 'GitHub oturumu geçersiz; yeniden giriş yapın.',
    });
    expect(describeStoreError(new AccountPairingStoreError('rate-limited'))).toBe(
      'GitHub istek sınırına takıldı; birkaç dakika sonra deneyin.'
    );
    expect(describeStoreError(new AccountPairingStoreError('network'))).toBe(
      "GitHub'a ulaşılamadı; internet bağlantısını kontrol edin."
    );
  });

  it('hata iletileri belirteç içermez', async () => {
    const gist = createMemoryGistServer({ [TOKEN]: { account: 'ben', scopes: [] } });
    const store = createAccountPairingStore({ getToken: () => TOKEN, http: gist.http });
    const result = await discoverHosts(store);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
