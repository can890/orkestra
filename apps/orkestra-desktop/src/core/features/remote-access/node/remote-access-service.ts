import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { err, ok, secret, type Result } from '@orkestra/shared';
import type { Logger } from '@orkestra/shared/logger';
import {
  base64UrlDecode,
  base64UrlEncode,
  isRemoteDeviceId,
  isValidRemoteAddress,
  randomBytes,
  REMOTE_NOTIFICATIONS_CHANNEL,
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
  AccountPairingState,
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
import {
  createRemoteNotificationsSurfaceController,
  createRemoteSurfaceController,
} from './remote-surface';

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

/** GitHub hesabıyla eşleşme ayarı; sır içermez (özel anahtar `SecretStore`'dadır). */
export type StoredAccountPairing = {
  enabled: boolean;
  /** Buluşma belgesinin gist kimliği (bulunduktan sonra önbelleklenir). */
  gistId: string | null;
  /** Masaüstünün ECDH açık anahtarı (base64url). */
  publicKey: string | null;
};

export type StoredRemoteAccessState = {
  version: 1;
  hostId: string;
  enabled: boolean;
  port: number | null;
  /** Eski kayıtlarda yoktur. */
  accountPairing?: StoredAccountPairing;
  /**
   * Eşleşmiş cihazlara ajan etkinliği (başlık, proje, durum, kısa önizleme) yayınlansın mı?
   * Eski kayıtlarda yoktur; varsayılan açık.
   */
  publishAgentActivity?: boolean;
  devices: StoredRemoteDevice[];
};

/** Uzak yüzeye eklenen ajan etkinliği akışı (bkz. `features/agent-activity`). */
export type AgentActivityPublisher = {
  /** `agentActivity` domain denetleyicisi (yalnızca uzak yüzeyde). */
  controller: Controller;
  setPublishing(enabled: boolean): void;
  dispose?(): void;
};

/** Hesap eşleşmesi koordinatörünün servisten gördüğü dar yüzey. */
export type AccountPairingHostPort = {
  getHostInfo(): Promise<{
    hostId: string;
    hostName: string;
    addresses: string[];
    /** Dinlenen port; dinlenmiyorsa `null`. */
    port: number | null;
    remoteEnabled: boolean;
    listening: boolean;
    secureStorageAvailable: boolean;
  }>;
  getSettings(): Promise<StoredAccountPairing>;
  saveSettings(settings: StoredAccountPairing): Promise<void>;
  registerDerivedDevice(input: DerivedDeviceInput): Promise<Result<void, RemoteAccessError>>;
};

export type DerivedDeviceInput = {
  deviceId: string;
  name: string;
  platform: string;
  /** İki uçta ayrı türetilen 32 baytlık sır; asla günlüğe yazılmaz. */
  secret: Uint8Array;
};

/** Servisin, kendisine bağlanan hesap eşleşmesi koordinatörüyle konuştuğu arayüz. */
export type AccountPairingControl = {
  start(): Promise<void>;
  dispose(): void;
  getStatus(): AccountPairingState;
  setEnabled(enabled: boolean): Promise<Result<AccountPairingState, RemoteAccessError>>;
  checkNow(): Promise<AccountPairingState>;
  /** Mobil erişim açıldı/kapandı ya da port değişti. */
  notifyHostChanged(): void;
};

const DISABLED_ACCOUNT_PAIRING: AccountPairingState = {
  enabled: false,
  status: 'off',
  login: null,
  lastCheckedAt: null,
  lastPairedDeviceName: null,
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
  private accountPairing: AccountPairingControl | undefined;
  private notificationsSurface: Controller | undefined;
  private agentActivity: AgentActivityPublisher | undefined;
  /** Arka plan bildirim kanalı açık cihazlar. */
  private readonly notificationsConnected = new Set<string>();

  constructor(private readonly deps: RemoteAccessServiceDeps) {}

  /**
   * Ajan etkinliği akışını bağlar: ana uzak yüzeye `agentActivity.*` eklenir ve telefonun arka plan
   * bildirim servisi için dar yüzeyli `notifications` kanalı açılır. `start`'tan önce çağrılmalıdır.
   */
  attachAgentActivity(publisher: AgentActivityPublisher): void {
    this.agentActivity = publisher;
  }
  /** GitHub hesabıyla eşleşme koordinatörünü bağlar (yoksa özellik kapalı sayılır). */
  attachAccountPairing(control: AccountPairingControl): void {
    this.accountPairing = control;
  }

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
    const remoteControllers = this.agentActivity
      ? { ...controllers, agentActivity: this.agentActivity.controller }
      : controllers;
    this.surface = createRemoteSurfaceController(remoteControllers);
    this.notificationsSurface = this.agentActivity
      ? createRemoteNotificationsSurfaceController(remoteControllers)
      : undefined;
    await this.exclusive(async () => {
      const state = await this.load();
      this.agentActivity?.setPublishing(state.publishAgentActivity ?? true);
      if (!state.enabled) return;
      const result = await this.startListening();
      if (!result.success) {
        this.deps.logger.warn('Remote access could not start', { reason: result.error.message });
      }
    });
    await this.accountPairing?.start();
  }

  /** Masaüstü ayarı: eşleşmiş cihazlara ajan etkinliği yayınlansın mı (varsayılan açık). */
  async setPublishAgentActivity(
    enabled: boolean
  ): Promise<Result<RemoteAccessState, RemoteAccessError>> {
    return await this.exclusive(async () => {
      const state = await this.load();
      state.publishAgentActivity = enabled;
      await this.deps.persistence.save(state);
      this.agentActivity?.setPublishing(enabled);
      this.deps.logger.info('Remote access agent activity publishing toggled', { enabled });
      return ok(this.snapshot(state));
    });
  }

  getAccountPairingState(): AccountPairingState {
    return this.accountPairing?.getStatus() ?? DISABLED_ACCOUNT_PAIRING;
  }

  async setAccountPairingEnabled(
    enabled: boolean
  ): Promise<Result<AccountPairingState, RemoteAccessError>> {
    if (!this.accountPairing) {
      return failure('failed', 'GitHub hesabıyla eşleşme bu sürümde kullanılamıyor.');
    }
    return await this.accountPairing.setEnabled(enabled);
  }

  async checkAccountPairingNow(): Promise<AccountPairingState> {
    return (await this.accountPairing?.checkNow()) ?? DISABLED_ACCOUNT_PAIRING;
  }

  /** Koordinatörün kullandığı dar yüzey (durum ve cihaz kaydı tek kuyrukta işlenir). */
  accountPairingHost(): AccountPairingHostPort {
    return {
      getHostInfo: () =>
        this.exclusive(async () => {
          const state = await this.load();
          return {
            hostId: state.hostId,
            hostName: this.deps.hostName().slice(0, 64),
            addresses: this.currentAddresses(),
            port: this.listener?.port ?? null,
            remoteEnabled: state.enabled,
            listening: this.listener !== undefined,
            secureStorageAvailable: this.deps.isSecureStorageAvailable(),
          };
        }),
      getSettings: () =>
        this.exclusive(async () => {
          const state = await this.load();
          return { enabled: false, gistId: null, publicKey: null, ...state.accountPairing };
        }),
      saveSettings: (settings) =>
        this.exclusive(async () => {
          const state = await this.load();
          state.accountPairing = { ...settings };
          await this.deps.persistence.save(state);
        }),
      registerDerivedDevice: (input) => this.registerDerivedDevice(input),
    };
  }

  /**
   * Sırrı QR ile değil iki uçta türetilerek belirlenen bir cihazı "bekleyen eşleşme" olarak kaydeder
   * (`createPairing` ile aynı kayıt: aynı sır anahtarı, `pairedAt: null`, 10 dk süre, aynı sınırlar).
   * Var olan (eşleşmiş ya da bekleyen) bir `deviceId` reddedilir. Sır asla günlüğe yazılmaz.
   */
  async registerDerivedDevice(input: DerivedDeviceInput): Promise<Result<void, RemoteAccessError>> {
    return await this.exclusive(async () => {
      if (!isRemoteDeviceId(input.deviceId) || input.secret.byteLength !== REMOTE_SECRET_BYTES) {
        return failure('failed', 'Geçersiz eşleşme isteği.');
      }
      const state = await this.load();
      if (!state.enabled || !this.listener) {
        return failure('not-enabled', 'Önce mobil erişimi açın.');
      }
      // Süresi dolmuş bekleyenler önce silinir; böylece eski bir kayıt yeni isteği engellemez.
      await this.purgeExpired();
      if (state.devices.some((device) => device.id === input.deviceId)) {
        return failure('device-exists', 'Bu cihaz zaten kayıtlı.');
      }
      const room = await this.makeRoomForPending(state);
      if (!room.success) return room;
      const stored = await this.storePairingSecret(input.deviceId, base64UrlEncode(input.secret));
      if (!stored.success) return stored;
      const now = this.now();
      state.devices.push({
        id: input.deviceId,
        name: input.name.trim().slice(0, 64) || PENDING_NAME,
        platform: input.platform.slice(0, 64) || null,
        createdAt: now,
        pairedAt: null,
        expiresAt: now + PAIRING_TTL_MS,
        lastSeenAt: null,
      });
      await this.deps.persistence.save(state);
      this.deps.logger.info('Remote access account pairing registered', {
        deviceId: input.deviceId,
      });
      return ok();
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
      this.accountPairing?.notifyHostChanged();
      return ok(this.snapshot(state));
    });
  }

  async createPairing(): Promise<Result<PairingResult, RemoteAccessError>> {
    return await this.exclusive(async () => {
      const state = await this.load();
      if (!state.enabled || !this.listener) {
        return failure('not-enabled', 'Önce mobil erişimi açın.');
      }
      const room = await this.makeRoomForPending(state);
      if (!room.success) return room;

      const deviceId = crypto.randomUUID();
      const secretBytes = randomBytes(REMOTE_SECRET_BYTES);
      const encoded = base64UrlEncode(secretBytes);
      const stored = await this.storePairingSecret(deviceId, encoded);
      if (!stored.success) return stored;
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
    this.accountPairing?.dispose();
    this.agentActivity?.dispose?.();
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
      notificationsConnected: this.notificationsConnected.has(device.id),
    }));
    return {
      enabled: state.enabled,
      listening: this.listener !== undefined,
      port: this.listener?.port ?? state.port,
      addresses: this.currentAddresses(),
      hostName: this.deps.hostName(),
      secureStorageAvailable: this.deps.isSecureStorageAvailable(),
      lastError: this.lastError,
      agentActivityAvailable: this.agentActivity !== undefined,
      publishAgentActivity: state.publishAgentActivity ?? true,
      devices,
    };
  }

  private currentAddresses(): string[] {
    const local = candidateAddresses(this.deps.networkInterfaces());
    const tunnelUrl = readActiveTunnelUrl(
      this.stored?.hostId,
      this.listener?.port ?? this.stored?.port
    );
    if (tunnelUrl && !local.includes(tunnelUrl)) {
      return [...local, tunnelUrl].slice(0, 6);
    }
    return local;
  }

  private async startListening(): Promise<Result<void, RemoteAccessError>> {
    if (this.listener) return ok();
    const surface = this.surface;
    if (!surface) return failure('failed', 'Uygulama henüz hazır değil.');
    const state = await this.load();
    const notificationsSurface = this.notificationsSurface;
    const server = createRemoteServer({
      controller: surface,
      ...(notificationsSurface
        ? { channelControllers: { [REMOTE_NOTIFICATIONS_CHANNEL]: notificationsSurface } }
        : {}),
      lookupSecret: (deviceId) => this.lookupSecret(deviceId),
      hostInfo: () => ({
        hostId: state.hostId,
        hostName: this.deps.hostName(),
        addresses: this.currentAddresses(),
        port: this.listener?.port ?? state.port ?? 0,
      }),
      onSessionOpen: (info) => void this.onSessionOpen(info),
      onSessionClose: (info) => void this.onSessionClose(info.deviceId, info.channel),
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
    this.notificationsConnected.clear();
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
    channel?: string;
  }): Promise<void> {
    if (info.channel === undefined) this.connected.add(info.deviceId);
    else if (info.channel === REMOTE_NOTIFICATIONS_CHANNEL)
      this.notificationsConnected.add(info.deviceId);
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

  private async onSessionClose(deviceId: string, channel?: string): Promise<void> {
    if (channel === undefined) this.connected.delete(deviceId);
    else if (channel === REMOTE_NOTIFICATIONS_CHANNEL) this.notificationsConnected.delete(deviceId);
    if (this.disposed) return;
    await this.exclusive(async () => {
      const state = await this.load();
      const device = state.devices.find((entry) => entry.id === deviceId);
      if (!device) return;
      device.lastSeenAt = this.now();
      await this.deps.persistence.save(state);
    });
  }

  /** Yeni bir bekleyen eşleşme için yer açar: süresi dolanlar silinir, sınırlar uygulanır. */
  private async makeRoomForPending(
    state: StoredRemoteAccessState
  ): Promise<Result<void, RemoteAccessError>> {
    await this.purgeExpired();
    const pending = state.devices.filter((device) => device.pairedAt === null);
    // En eski bekleyen eşleştirmeler iptal edilir (aynı anda en çok MAX_PENDING_PAIRINGS).
    while (pending.length >= MAX_PENDING_PAIRINGS) {
      await this.removeDevice(state, pending.shift()!.id);
    }
    if (state.devices.length >= MAX_DEVICES) {
      return failure('device-limit', `En fazla ${MAX_DEVICES} cihaz eşleştirilebilir.`);
    }
    return ok();
  }

  private async storePairingSecret(
    deviceId: string,
    encoded: string
  ): Promise<Result<void, RemoteAccessError>> {
    try {
      await this.deps.secrets.setSecret(secretKey(deviceId), secret(encoded, 'remote-access'));
    } catch {
      // Hata nesnesi sır içermez ama yine de yalnızca genel mesaj döneriz.
      return failure('storage-unavailable', 'Eşleştirme sırrı güvenli depoya yazılamadı.');
    }
    return ok();
  }

  /** Cihaz kaydını, sırrını ve açık bağlantısını kaldırır (kaydetmek çağıranın işidir). */
  private async removeDevice(state: StoredRemoteAccessState, deviceId: string): Promise<void> {
    state.devices = state.devices.filter((entry) => entry.id !== deviceId);
    this.connected.delete(deviceId);
    this.notificationsConnected.delete(deviceId);
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

function readActiveTunnelUrl(hostId?: string, port?: number | null): string | null {
  try {
    const filePath =
      process.env.SOVRA_TUNNEL_STATE_FILE ||
      path.join(os.homedir(), '.local', 'state', 'sovra', 'tunnel-url.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      hostId?: unknown;
      port?: unknown;
      tunnelUrl?: unknown;
      updatedAt?: unknown;
    };
    if (typeof parsed.tunnelUrl !== 'string' || !parsed.tunnelUrl.startsWith('wss://')) return null;
    if (!isValidRemoteAddress(parsed.tunnelUrl)) return null;
    if (hostId && typeof parsed.hostId === 'string' && parsed.hostId !== hostId) return null;
    if (port && typeof parsed.port === 'number' && parsed.port !== port) return null;
    if (typeof parsed.updatedAt === 'number' && Date.now() - parsed.updatedAt > 24 * 60 * 60_000) {
      return null;
    }
    return parsed.tunnelUrl;
  } catch {
    return null;
  }
}

function randomPort(): number {
  const bytes = randomBytes(2);
  const value = (bytes[0]! << 8) | bytes[1]!;
  return 49152 + (value % (65000 - 49152));
}
