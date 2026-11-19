import { err, ok, secret, type Result } from '@orkestra/shared';
import type { Logger } from '@orkestra/shared/logger';
import {
  base64UrlDecode,
  base64UrlEncode,
  randomBytes,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SECRET_BYTES,
} from '@orkestra/wire/remote';
import {
  createRemoteServer,
  listenRemoteServer,
  type RemoteListener,
  type RemoteListenOptions,
  type RemoteServer,
} from '@orkestra/wire/remote/node';
import type { Controller } from '@orkestra/wire/rpc';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import type {
  PairingResult,
  RemoteAccessError,
  RemoteAccessState,
  RemoteDevice,
} from '../api/contract';
import {
  PAIRING_PAYLOAD_KIND,
  serializePairingPayload,
  type PairingPayload,
} from '../api/pairing-payload';
import { candidateAddresses, type NetworkInterfaceMap } from './network-addresses';
import { createRemoteSurfaceController } from './remote-surface';

/** Sürümlü, sır içermeyen kalıcı durum (sırlar `SecretStore`'da). */
export type StoredRemoteDevice = {
  id: string;
  name: string;
  platform: string | null;
  createdAt: number;
  /** `null`: QR üretildi ama telefon henüz eşleşmedi. */
  pairedAt: number | null;
  expiresAt: number | null;
  lastSeenAt: number | null;
};

export type StoredRemoteAccessState = {
  version: 1;
  hostId: string;
  enabled: boolean;
  port: number | null;
  devices: StoredRemoteDevice[];
};

export type RemoteAccessPersistence = {
  load(): Promise<StoredRemoteAccessState | null>;
  save(state: StoredRemoteAccessState): Promise<void>;
};

export type RemoteAccessServiceDeps = {
  persistence: RemoteAccessPersistence;
  secrets: SecretStore;
  logger: Logger;
  hostName: () => string;
  networkInterfaces: () => NetworkInterfaceMap;
  isSecureStorageAvailable: () => boolean;
  /** Test için: gerçek ağ yerine sahte dinleyici. */
  listen?: (server: RemoteServer, options: RemoteListenOptions) => Promise<RemoteListener>;
  now?: () => number;
  pickPort?: () => number;
  /** Dinlenecek arayüz; LAN/Tailscale için `0.0.0.0`. */
  bindHost?: string;
};

export const PAIRING_TTL_MS = 10 * 60_000;
export const MAX_DEVICES = 10;
export const MAX_PENDING_PAIRINGS = 3;
const PENDING_NAME = 'Eşleşmeyi bekliyor';
const SECRET_KEY_PREFIX = 'remoteAccess.device.';

function secretKey(deviceId: string): string {
  return `${SECRET_KEY_PREFIX}${deviceId}`;
}

function failure(
  type: RemoteAccessError['type'],
  message: string
): Result<never, RemoteAccessError> {
  return err({ type, message });
}

/**
 * Mobil uzak erişim geçidinin masaüstü servisi. VARSAYILAN KAPALI: kullanıcı ayardan açmadan
 * hiçbir port dinlenmez. Eşleştirme sırları yalnızca `SecretStore`'da (OS anahtarlığı) yaşar
 * ve asla loglanmaz. Sunulan yüzey `remote-surface.ts` izin listesiyle sınırlıdır.
 */
export class RemoteAccessService {
  private stored: StoredRemoteAccessState | undefined;
  private surface: Controller | undefined;
  private server: RemoteServer | undefined;
  private listener: RemoteListener | undefined;
  private lastError: string | null = null;
  private readonly connected = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: RemoteAccessServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Yazma işlemlerini sıraya sokar (kalıcı durum ve dinleyici yarışmasın). */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => {});
    return next;
  }

  /**
   * Açılış sonrası çağrılır: masaüstü denetleyicileri hazırdır. Ayar açıksa dinlemeye başlar;
   * kapalıysa hiçbir şey yapmaz.
   */
  async start(controllers: Record<string, Controller>): Promise<void> {
    this.surface = createRemoteSurfaceController(controllers);
    await this.exclusive(async () => {
      const state = await this.load();
      if (!state.enabled) return;
      const result = await this.startListening();
      if (!result.success) {
        this.deps.logger.warn('Remote access could not start', { reason: result.error.message });
      }
    });
  }

  async getState(): Promise<RemoteAccessState> {
    return await this.exclusive(async () => {
      await this.purgeExpired();
      return this.snapshot(await this.load());
    });
  }

  async setEnabled(enabled: boolean): Promise<Result<RemoteAccessState, RemoteAccessError>> {
    return await this.exclusive(async () => {
      const state = await this.load();
      if (enabled) {
        if (!this.deps.isSecureStorageAvailable()) {
          return failure(
            'storage-unavailable',
            'Eşleştirme sırlarını saklayacak güvenli depolama (anahtarlık) bu sistemde kullanılamıyor.'
          );
        }
        if (!this.surface) return failure('failed', 'Uygulama henüz hazır değil.');
        const started = await this.startListening();
        if (!started.success) return started;
        state.enabled = true;
      } else {
        await this.stopListening();
        await this.dropPending(state);
        state.enabled = false;
      }
      await this.deps.persistence.save(state);
      this.deps.logger.info('Remote access toggled', { enabled });
      return ok(this.snapshot(state));
    });
  }

  async createPairing(): Promise<Result<PairingResult, RemoteAccessError>> {
    return await this.exclusive(async () => {
      const state = await this.load();
      if (!state.enabled || !this.listener) {
        return failure('not-enabled', 'Önce mobil erişimi açın.');
      }
      await this.purgeExpired();
      const pending = state.devices.filter((device) => device.pairedAt === null);
      // En eski bekleyen eşleştirmeler iptal edilir (aynı anda en çok MAX_PENDING_PAIRINGS).
      while (pending.length >= MAX_PENDING_PAIRINGS) {
        await this.removeDevice(state, pending.shift()!.id);
      }
      if (state.devices.length >= MAX_DEVICES) {
        return failure('device-limit', `En fazla ${MAX_DEVICES} cihaz eşleştirilebilir.`);
      }

      const deviceId = crypto.randomUUID();
      const secretBytes = randomBytes(REMOTE_SECRET_BYTES);
      const encoded = base64UrlEncode(secretBytes);
      try {
        await this.deps.secrets.setSecret(secretKey(deviceId), secret(encoded, 'remote-access'));
      } catch {
        // Hata nesnesi sır içermez ama yine de yalnızca genel mesaj döneriz.
        return failure('storage-unavailable', 'Eşleştirme sırrı güvenli depoya yazılamadı.');
      }
      const now = this.now();
      const expiresAt = now + PAIRING_TTL_MS;
      state.devices.push({
        id: deviceId,
        name: PENDING_NAME,
        platform: null,
        createdAt: now,
        pairedAt: null,
        expiresAt,
        lastSeenAt: null,
      });
      await this.deps.persistence.save(state);

      const payload: PairingPayload = {
        k: PAIRING_PAYLOAD_KIND,
        v: REMOTE_PROTOCOL_VERSION,
        h: state.hostId,
        n: this.deps.hostName().slice(0, 64),
        a: this.currentAddresses(),
        p: this.listener.port,
        d: deviceId,
        s: encoded,
      };
      this.deps.logger.info('Remote access pairing created', { deviceId });
      return ok({ deviceId, expiresAt, payload: serializePairingPayload(payload) });
    });
  }

  async cancelPairing(deviceId: string): Promise<Result<void, RemoteAccessError>> {
    return await this.exclusive(async () => {
      const state = await this.load();
      const device = state.devices.find((entry) => entry.id === deviceId);
      if (!device || device.pairedAt !== null) {
        return failure('not-found', 'Bekleyen eşleştirme bulunamadı.');
      }
      await this.removeDevice(state, deviceId);
      await this.deps.persistence.save(state);
      return ok();
    });
  }

  /** Cihazı siler: önce sır silinir (yeniden bağlanamaz), sonra açık bağlantı hemen kapatılır. */
  async revokeDevice(deviceId: string): Promise<Result<void, RemoteAccessError>> {
    return await this.exclusive(async () => {
      const state = await this.load();
      if (!state.devices.some((entry) => entry.id === deviceId)) {
        return failure('not-found', 'Cihaz bulunamadı.');
      }
      await this.removeDevice(state, deviceId);
      await this.deps.persistence.save(state);
      this.deps.logger.info('Remote access device revoked', { deviceId });
      return ok();
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.exclusive(async () => {
      await this.stopListening();
    });
  }

  // --- İç işlemler -----------------------------------------------------------------------

  private async load(): Promise<StoredRemoteAccessState> {
    if (this.stored) return this.stored;
    const loaded = await this.deps.persistence.load();
    this.stored = loaded ?? {
      version: 1,
      hostId: crypto.randomUUID(),
      enabled: false,
      port: null,
      devices: [],
    };
    return this.stored;
  }

  private snapshot(state: StoredRemoteAccessState): RemoteAccessState {
    const devices: RemoteDevice[] = state.devices.map((device) => ({
      id: device.id,
      name: device.name,
      platform: device.platform,
      status: device.pairedAt === null ? 'pending' : 'paired',
      createdAt: device.createdAt,
      expiresAt: device.pairedAt === null ? device.expiresAt : null,
      pairedAt: device.pairedAt,
      lastSeenAt: device.lastSeenAt,
      connected: this.connected.has(device.id),
    }));
    return {
      enabled: state.enabled,
      listening: this.listener !== undefined,
      port: this.listener?.port ?? state.port,
      addresses: this.currentAddresses(),
      hostName: this.deps.hostName(),
      secureStorageAvailable: this.deps.isSecureStorageAvailable(),
      lastError: this.lastError,
      devices,
    };
  }

  private currentAddresses(): string[] {
    return candidateAddresses(this.deps.networkInterfaces());
  }

  private async startListening(): Promise<Result<void, RemoteAccessError>> {
    if (this.listener) return ok();
    const surface = this.surface;
    if (!surface) return failure('failed', 'Uygulama henüz hazır değil.');
    const state = await this.load();
    const server = createRemoteServer({
      controller: surface,
      lookupSecret: (deviceId) => this.lookupSecret(deviceId),
      hostInfo: () => ({
        hostId: state.hostId,
        hostName: this.deps.hostName(),
        addresses: this.currentAddresses(),
        port: this.listener?.port ?? state.port ?? 0,
      }),
      onSessionOpen: (info) => void this.onSessionOpen(info),
      onSessionClose: (info) => void this.onSessionClose(info.deviceId),
      onRejected: (info) =>
        this.deps.logger.warn('Remote access handshake rejected', {
          reason: info.reason,
          remoteAddress: info.remoteAddress,
          deviceId: info.deviceId,
        }),
      now: this.deps.now,
    });

    const listen = this.deps.listen ?? listenRemoteServer;
    const host = this.deps.bindHost ?? '0.0.0.0';
    const pickPort = this.deps.pickPort ?? randomPort;
    let port = state.port ?? pickPort();
    let lastFailure: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        this.listener = await listen(server, { host, port });
        break;
      } catch (error) {
        lastFailure = error;
        if ((error as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') break;
        port = pickPort();
      }
    }
    if (!this.listener) {
      this.lastError = 'Port açılamadı; başka bir uygulama kullanıyor olabilir.';
      this.deps.logger.warn('Remote access listen failed', {
        code: (lastFailure as NodeJS.ErrnoException | undefined)?.code,
      });
      return failure('listen-failed', this.lastError);
    }
    this.server = server;
    this.lastError = null;
    if (state.port !== this.listener.port) {
      state.port = this.listener.port;
      await this.deps.persistence.save(state);
    }
    this.deps.logger.info('Remote access listening', { port: this.listener.port });
    return ok();
  }

  private async stopListening(): Promise<void> {
    const listener = this.listener;
    this.listener = undefined;
    this.server = undefined;
    this.connected.clear();
    if (listener) {
      await listener.close().catch(() => {});
      this.deps.logger.info('Remote access stopped');
    }
  }

  private async lookupSecret(deviceId: string): Promise<Uint8Array | null> {
    const state = await this.load();
    const device = state.devices.find((entry) => entry.id === deviceId);
    if (!device) return null;
    if (device.pairedAt === null && device.expiresAt !== null && device.expiresAt <= this.now()) {
      // Süresi dolmuş eşleştirme: sessizce temizle.
      void this.exclusive(async () => {
        await this.purgeExpired();
      });
      return null;
    }
    const stored = await this.deps.secrets.getSecret(secretKey(deviceId));
    if (!stored) return null;
    const bytes = base64UrlDecode(stored.expose());
    return bytes && bytes.byteLength === REMOTE_SECRET_BYTES ? bytes : null;
  }

  private async onSessionOpen(info: {
    deviceId: string;
    clientName?: string;
    platform?: string;
  }): Promise<void> {
    this.connected.add(info.deviceId);
    await this.exclusive(async () => {
      const state = await this.load();
      const device = state.devices.find((entry) => entry.id === info.deviceId);
      if (!device) return;
      const now = this.now();
      if (device.pairedAt === null) {
        device.pairedAt = now;
        device.expiresAt = null;
        device.name = info.clientName || 'Telefon';
        this.deps.logger.info('Remote access device paired', { deviceId: device.id });
      }
      if (info.platform) device.platform = info.platform;
      device.lastSeenAt = now;
      await this.deps.persistence.save(state);
    });
  }

  private async onSessionClose(deviceId: string): Promise<void> {
    this.connected.delete(deviceId);
    if (this.disposed) return;
    await this.exclusive(async () => {
      const state = await this.load();
      const device = state.devices.find((entry) => entry.id === deviceId);
      if (!device) return;
      device.lastSeenAt = this.now();
      await this.deps.persistence.save(state);
    });
  }

  /** Cihaz kaydını, sırrını ve açık bağlantısını kaldırır (kaydetmek çağıranın işidir). */
  private async removeDevice(state: StoredRemoteAccessState, deviceId: string): Promise<void> {
    state.devices = state.devices.filter((entry) => entry.id !== deviceId);
    this.connected.delete(deviceId);
    await this.deps.secrets.deleteSecret(secretKey(deviceId));
    this.server?.closeDevice(deviceId);
  }

  private async dropPending(state: StoredRemoteAccessState): Promise<void> {
    for (const device of state.devices.filter((entry) => entry.pairedAt === null)) {
      await this.removeDevice(state, device.id);
    }
  }

  private async purgeExpired(): Promise<void> {
    const state = await this.load();
    const now = this.now();
    const expired = state.devices.filter(
      (device) => device.pairedAt === null && device.expiresAt !== null && device.expiresAt <= now
    );
    if (expired.length === 0) return;
    for (const device of expired) await this.removeDevice(state, device.id);
    await this.deps.persistence.save(state);
  }
}

function randomPort(): number {
  const bytes = randomBytes(2);
  const value = (bytes[0]! << 8) | bytes[1]!;
  return 49152 + (value % (65000 - 49152));
}
