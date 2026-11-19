import { describe, expect, it } from 'vitest';
import {
  emptyAccountPairingDocument,
  generateAccountPairingKeyPair,
  parseAccountPairingDocument,
  serializeAccountPairingDocument,
  withAccountPairingHost,
  withAccountPairingRequest,
  type AccountPairingHost,
  type AccountPairingRequest,
} from './account-pairing';
import {
  AccountPairingStoreError,
  createAccountPairingStore,
  createMemoryGistServer,
} from './account-pairing-store';

const HOST_ID = '3f0c1a52-6d1e-4b8e-9f0a-2b7c5d9e1a44';
const DEVICE_ID = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const DESKTOP_TOKEN = 'desktop-token-value';
const PHONE_TOKEN = 'phone-token-value';

async function hostEntry(): Promise<AccountPairingHost> {
  return {
    id: HOST_ID,
    name: 'Ornek-Mac',
    addresses: ['192.168.1.20'],
    port: 50123,
    publicKey: (await generateAccountPairingKeyPair()).publicKey,
    updatedAt: 1_800_000_000_000,
  };
}

async function requestEntry(): Promise<AccountPairingRequest> {
  return {
    deviceId: DEVICE_ID,
    hostId: HOST_ID,
    name: 'Pixel',
    platform: 'android',
    publicKey: (await generateAccountPairingKeyPair()).publicKey,
    createdAt: 1_800_000_000_500,
  };
}

function setup() {
  const server = createMemoryGistServer({
    [DESKTOP_TOKEN]: { account: 'ornek' },
    [PHONE_TOKEN]: { account: 'ornek' },
    'other-token': { account: 'baskasi' },
    'no-gist-token': { account: 'ornek', scopes: ['repo'] },
  });
  const store = (token: string) =>
    createAccountPairingStore({ getToken: () => token, http: server.http });
  return { server, store };
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AccountPairingStoreError) return error.code;
    throw error;
  }
  return 'no-error';
}

describe('account pairing store', () => {
  it('creates the document once and lets the same account find it from another device', async () => {
    const { server, store } = setup();
    const host = await hostEntry();
    const created = await store(DESKTOP_TOKEN).update({
      gistId: null,
      create: true,
      change: (document) => withAccountPairingHost(document, host),
      verify: (document) => document.hosts.some((entry) => entry.id === HOST_ID),
    });
    expect(created?.document.hosts).toEqual([host]);

    const phone = store(PHONE_TOKEN);
    const found = await phone.find();
    expect(found).toBe(created?.gistId);
    const read = await phone.read(found!);
    expect(read.status === 'ok' && read.document.hosts[0]?.name).toBe('Ornek-Mac');

    // Aynı belge yeniden kullanılır; ikinci bir gist açılmaz.
    await store(DESKTOP_TOKEN).update({
      gistId: null,
      create: true,
      change: (document) => withAccountPairingHost(document, { ...host, port: 50124 }),
      verify: (document) => document.hosts[0]?.port === 50124,
    });
    expect(server.log.filter((entry) => entry.method === 'POST')).toHaveLength(1);
  });

  it('does not show another account the document, and refuses its writes', async () => {
    const { store } = setup();
    const host = await hostEntry();
    const created = await store(DESKTOP_TOKEN).update({
      gistId: null,
      create: true,
      change: (document) => withAccountPairingHost(document, host),
      verify: () => true,
    });
    const stranger = store('other-token');
    expect(await stranger.find()).toBeNull();

    // Adresi bilen okuyabilir (içinde sır yok) ama yazamaz: yazma isteği yeni bir gist'e düşer.
    const request = await requestEntry();
    await stranger.update({
      gistId: created!.gistId,
      create: true,
      change: (document) => withAccountPairingRequest(document, request),
      verify: (document) => document.requests.length === 1,
    });
    const owners = await store(DESKTOP_TOKEN).read(created!.gistId);
    expect(owners.status === 'ok' && owners.document.requests).toEqual([]);
  });

  it('answers not-modified for an unchanged document', async () => {
    const { server, store } = setup();
    const desktop = store(DESKTOP_TOKEN);
    const created = await desktop.update({
      gistId: null,
      create: true,
      change: (document) => document,
      verify: () => true,
    });
    expect((await desktop.read(created!.gistId, created!.etag)).status).toBe('not-modified');

    server.overwrite('ornek', serializeAccountPairingDocument(emptyAccountPairingDocument()));
    expect((await desktop.read(created!.gistId, created!.etag)).status).toBe('ok');
  });

  it('retries when a concurrent write drops its change', async () => {
    const { server, store } = setup();
    const host = await hostEntry();
    const request = await requestEntry();
    const created = await store(DESKTOP_TOKEN).update({
      gistId: null,
      create: true,
      change: (document) => withAccountPairingHost(document, host),
      verify: () => true,
    });

    // Telefon isteğini yazdıktan hemen sonra masaüstü eski içerikle belgeyi ezer.
    let clobbered = false;
    const stale = serializeAccountPairingDocument(
      withAccountPairingHost(emptyAccountPairingDocument(), host)
    );
    const phone = createAccountPairingStore({
      getToken: () => PHONE_TOKEN,
      http: async (request) => {
        const response = await server.http(request);
        if (!clobbered && request.method === 'PATCH') {
          clobbered = true;
          server.overwrite('ornek', stale);
        }
        return response;
      },
    });
    const written = await phone.update({
      gistId: created!.gistId,
      change: (document) => withAccountPairingRequest(document, request),
      verify: (document) => document.requests.some((entry) => entry.deviceId === DEVICE_ID),
    });

    expect(clobbered).toBe(true);
    expect(written?.document.requests).toEqual([request]);
    expect(parseAccountPairingDocument(server.contentOf('ornek'))?.requests).toEqual([request]);
  });

  it('gives up with a conflict when its change never sticks', async () => {
    const { store } = setup();
    const code = await codeOf(() =>
      store(DESKTOP_TOKEN).update({
        gistId: null,
        create: true,
        change: (document) => document,
        verify: () => false,
      })
    );
    expect(code).toBe('conflict');
  });

  it('returns null instead of creating when the document is missing', async () => {
    const { server, store } = setup();
    const result = await store(PHONE_TOKEN).update({
      gistId: null,
      change: (document) => document,
      verify: () => true,
    });
    expect(result).toBeNull();
    expect(server.log.some((entry) => entry.method === 'POST')).toBe(false);
  });

  it('recreates the document after the gist was deleted', async () => {
    const { server, store } = setup();
    const desktop = store(DESKTOP_TOKEN);
    const host = await hostEntry();
    const input = {
      create: true,
      change: (document: Parameters<typeof withAccountPairingHost>[0]) =>
        withAccountPairingHost(document, host),
      verify: () => true,
    };
    const first = await desktop.update({ gistId: null, ...input });
    server.deleteAll();
    expect((await desktop.read(first!.gistId)).status).toBe('missing');

    const second = await desktop.update({ gistId: first!.gistId, ...input });
    expect(second?.gistId).not.toBe(first?.gistId);
    expect(second?.document.hosts).toEqual([host]);
  });

  it('treats unreadable content as an empty document', async () => {
    const { server, store } = setup();
    const desktop = store(DESKTOP_TOKEN);
    const created = await desktop.update({
      gistId: null,
      create: true,
      change: (document) => document,
      verify: () => true,
    });
    server.overwrite('ornek', 'bu JSON değil');
    const read = await desktop.read(created!.gistId);
    expect(read.status === 'ok' && read.document).toEqual(emptyAccountPairingDocument());
  });

  it('reports a rejected token and a token without the gist scope', async () => {
    const { store } = setup();
    expect(await codeOf(() => store('unknown-token').find())).toBe('unauthorized');
    expect(await codeOf(() => store('no-gist-token').find())).toBe('missing-scope');
  });

  it('maps transport failures to a code and never exposes the token', async () => {
    const failing = createAccountPairingStore({
      getToken: () => DESKTOP_TOKEN,
      http: async () => {
        throw new Error(`connect failed for Bearer ${DESKTOP_TOKEN}`);
      },
    });
    let caught: unknown;
    try {
      await failing.find();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AccountPairingStoreError);
    expect((caught as AccountPairingStoreError).code).toBe('network');
    expect(String((caught as Error).message)).not.toContain(DESKTOP_TOKEN);
    expect(JSON.stringify(caught)).not.toContain(DESKTOP_TOKEN);
  });

  it('never records the token in the request log', async () => {
    const { server, store } = setup();
    await store(DESKTOP_TOKEN).find();
    expect(JSON.stringify(server.log)).not.toContain(DESKTOP_TOKEN);
  });
});
