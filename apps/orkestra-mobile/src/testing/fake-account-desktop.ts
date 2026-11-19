import {
  createAccountPairingStore,
  type createMemoryGistServer,
  deriveAccountPairingSecret,
  generateAccountPairingKeyPair,
  isAccountPairingRequestExpired,
  withAccountPairingHost,
  withoutAccountPairingRequests,
  type AccountPairingStore,
} from '@orkestra/wire/remote';
import {
  createRemoteServer,
  listenRemoteServer,
  type RemoteListener,
} from '@orkestra/wire/remote/node';
import { createFakeDesktop, type FakeDesktop } from './fake-desktop';

/**
 * Test desteği: hesap üzerinden eşleşmede masaüstü rolünü oynar. Gerçek bir uzak sunucuyu
 * `127.0.0.1`de dinler, buluşma belgesine kendi kaydını yazar ve `approvePending` ile bekleyen
 * istekleri okuyup sırrı `role: 'host'` ile türetir ve cihazı kaydeder (gerçek masaüstünün yaptığı).
 */
export type FakeAccountDesktop = {
  desktop: FakeDesktop;
  store: AccountPairingStore;
  hostId: string;
  publicKey: string;
  port: number;
  /** Kayıtlı (sırrı türetilmiş) cihaz kimlikleri. */
  knownDevices(): string[];
  publish(): Promise<void>;
  /** `removeRequests: false`: cihazı kaydeder ama isteği belgede bırakır. */
  approvePending(options?: { removeRequests?: boolean }): Promise<string[]>;
  close(): Promise<void>;
};

export async function createFakeAccountDesktop(input: {
  gist: ReturnType<typeof createMemoryGistServer>;
  token: string;
  hostId: string;
  name?: string;
}): Promise<FakeAccountDesktop> {
  const keys = await generateAccountPairingKeyPair();
  const store = createAccountPairingStore({ getToken: () => input.token, http: input.gist.http });
  const desktop = createFakeDesktop();
  const known = new Map<string, Uint8Array>();
  const bound = { port: 0 };
  const server = createRemoteServer({
    controller: desktop.controller,
    lookupSecret: async (id) => known.get(id) ?? null,
    hostInfo: () => ({
      hostId: input.hostId,
      hostName: input.name ?? 'Test Mac',
      addresses: ['127.0.0.1'],
      port: bound.port,
    }),
  });
  const listener: RemoteListener = await listenRemoteServer(server, {
    host: '127.0.0.1',
    port: 0,
  });
  bound.port = listener.port;
  const port = listener.port;

  return {
    desktop,
    store,
    hostId: input.hostId,
    publicKey: keys.publicKey,
    port,
    knownDevices: () => [...known.keys()],
    async publish() {
      await store.update({
        gistId: null,
        create: true,
        change: (document) =>
          withAccountPairingHost(document, {
            id: input.hostId,
            name: input.name ?? 'Test Mac',
            addresses: ['127.0.0.1'],
            port,
            publicKey: keys.publicKey,
            updatedAt: Date.now(),
          }),
        verify: (document) => document.hosts.some((host) => host.id === input.hostId),
      });
    },
    async approvePending(options = {}) {
      const gistId = await store.find();
      if (!gistId) return [];
      const read = await store.read(gistId);
      if (read.status !== 'ok') return [];
      const approved: string[] = [];
      for (const request of read.document.requests) {
        if (request.hostId !== input.hostId) continue;
        if (isAccountPairingRequestExpired(request, Date.now())) continue;
        known.set(
          request.deviceId,
          await deriveAccountPairingSecret({
            role: 'host',
            privateKey: keys.privateKey,
            ownPublicKey: keys.publicKey,
            peerPublicKey: request.publicKey,
            hostId: input.hostId,
            deviceId: request.deviceId,
          })
        );
        approved.push(request.deviceId);
      }
      if (approved.length > 0 && options.removeRequests !== false) {
        await store.update({
          gistId,
          change: (document) => withoutAccountPairingRequests(document, approved),
          verify: (document) => !document.requests.some((r) => approved.includes(r.deviceId)),
        });
      }
      return approved;
    },
    async close() {
      await listener.close();
    },
  };
}
