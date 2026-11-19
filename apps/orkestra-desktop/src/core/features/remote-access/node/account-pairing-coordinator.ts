import { err, ok, secret, type Result } from '@orkestra/shared';
import type { Logger } from '@orkestra/shared/logger';
import {
  AccountPairingStoreError,
  createAccountPairingStore,
  deriveAccountPairingSecret,
  fetchAccountPairingHttp,
  generateAccountPairingKeyPair,
  isAccountPairingRequestExpired,
  withAccountPairingHost,
  withoutAccountPairingHost,
  withoutAccountPairingRequests,
  type AccountPairingDocument,
  type AccountPairingHost,
  type AccountPairingHttp,
  type AccountPairingRequest,
  type AccountPairingStore,
} from '@orkestra/wire/remote';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import type { AccountPairingState, RemoteAccessError } from '../api/contract';
import type {
  AccountPairingControl,
  AccountPairingHostPort,
  StoredAccountPairing,
} from './remote-access-service';

/** Ana makinenin ECDH özel anahtarı (JWK, JSON metni); yalnızca güvenli sır deposunda tutulur. */
export const ACCOUNT_PAIRING_HOST_KEY_SECRET = 'remoteAccess.accountPairing.hostKey';
export const ACCOUNT_PAIRING_POLL_MS = 30_000;
export const ACCOUNT_PAIRING_MAX_BACKOFF_MS = 5 * 60_000;
/** Yayınlanan kayıt değişmese de bu kadar eskiyince tazelenir (telefon eski kaydı atabilir). */
export const ACCOUNT_PAIRING_REPUBLISH_MS = 24 * 60 * 60_000;

export type AccountPairingAccount = {
  login: string;
  accountId: string;
  accessToken: string;
  apiBaseUrl: string;
};

/** Test için değiştirilebilir zamanlayıcı; dönen işlev zamanlamayı iptal eder. */
export type AccountPairingScheduler = (run: () => void, delayMs: number) => () => void;

export const defaultAccountPairingScheduler: AccountPairingScheduler = (run, delayMs) => {
  const handle = setTimeout(run, delayMs);
  // Zamanlayıcı uygulamanın kapanmasını engellemesin.
  handle.unref?.();
  return () => clearTimeout(handle);
};

export type AccountPairingCoordinatorDeps = {
  host: AccountPairingHostPort;
  secrets: SecretStore;
  logger: Logger;
  /** Varsayılan GitHub hesabı; yoksa `null`. */
  getAccount: () => Promise<AccountPairingAccount | null>;
  http?: AccountPairingHttp;
  now?: () => number;
  scheduler?: AccountPairingScheduler;
  pollMs?: number;
};

type FailureKind = 'missing-scope' | 'unauthorized' | 'transient';

function failure(
  type: RemoteAccessError['type'],
  message: string
): Result<never, RemoteAccessError> {
  return err({ type, message });
}

function sameEntry(a: AccountPairingHost, b: AccountPairingHost): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.port === b.port &&
    a.publicKey === b.publicKey &&
    a.addresses.length === b.addresses.length &&
    a.addresses.every((address, index) => address === b.addresses[index])
  );
}

function requestKey(request: Pick<AccountPairingRequest, 'deviceId' | 'createdAt'>): string {
  return `${request.deviceId}|${request.createdAt}`;
}

/**
 * GitHub hesabıyla eşleşme (QR'sız) masaüstü tarafı. Ayar açıkken ve mobil erişim dinlerken kendi
 * kaydını hesabın gizli gist'ine yazar, belgeyi 30 sn'de bir (ETag'li) okur ve aynı hesaptan gelen
 * geçerli istekleri "bekleyen eşleşme"ye çevirir. Güven modeli `@orkestra/wire/remote`
 * `account-pairing.ts` içinde anlatılır: belgeye yalnızca hesap sahibi yazabilir; belgeye sır
 * yazılmaz. GitHub belirteci, özel anahtar ve türetilen sır hiçbir günlüğe ya da hataya girmez.
 */
export class AccountPairingCoordinator implements AccountPairingControl {
  private chain: Promise<unknown> = Promise.resolve();
  private cancelTimer: (() => void) | undefined;
  private disposed = false;

  private settingEnabled = false;
  private remoteActive = false;
  private hasAccount = true;
  private login: string | null = null;
  private blocked: 'missing-scope' | 'unauthorized' | null = null;
  private failing = false;
  private failures = 0;
  private lastCheckedAt: number | null = null;
  private lastPairedDeviceName: string | null = null;

  private etag: string | null = null;
  private publishedEntry: AccountPairingHost | null = null;
  private publishedAt = 0;
  /** Bu süreçte kayıt geri çekildi mi? (Gereksiz ağ çağrısını önler.) */
  private retracted = false;

  constructor(private readonly deps: AccountPairingCoordinatorDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => {});
    return next;
  }

  // --- AccountPairingControl -------------------------------------------------------------

  async start(): Promise<void> {
    await this.exclusive(() => this.tick());
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  getStatus(): AccountPairingState {
    return {
      enabled: this.settingEnabled,
      status: this.status(),
      login: this.login,
      lastCheckedAt: this.lastCheckedAt,
      lastPairedDeviceName: this.lastPairedDeviceName,
    };
  }

  notifyHostChanged(): void {
    if (this.disposed) return;
    void this.exclusive(() => this.tick()).catch(() => {});
  }

  async checkNow(): Promise<AccountPairingState> {
    await this.exclusive(async () => {
      this.blocked = null;
      this.failures = 0;
      this.etag = null;
      await this.tick();
    });
    return this.getStatus();
  }

  async setEnabled(enabled: boolean): Promise<Result<AccountPairingState, RemoteAccessError>> {
    return await this.exclusive(async () => {
      const settings = await this.deps.host.getSettings();
      if (enabled) {
        const info = await this.deps.host.getHostInfo();
        if (!info.secureStorageAvailable) {
          return failure(
            'storage-unavailable',
            'Anahtarı saklayacak güvenli depolama (anahtarlık) bu sistemde kullanılamıyor.'
          );
        }
        const next = await this.ensureKey(settings).catch(() => null);
        if (!next) {
          return failure('storage-unavailable', 'Eşleşme anahtarı güvenli depoya yazılamadı.');
        }
        await this.deps.host.saveSettings({ ...next, enabled: true });
        this.blocked = null;
        this.failing = false;
        this.failures = 0;
        this.etag = null;
        await this.tick();
      } else {
        this.clearTimer();
        await this.retract(settings, (await this.deps.host.getHostInfo()).hostId);
        await this.deps.secrets.deleteSecret(ACCOUNT_PAIRING_HOST_KEY_SECRET);
        await this.deps.host.saveSettings({ enabled: false, gistId: null, publicKey: null });
        this.resetRuntime();
        this.settingEnabled = false;
      }
      return ok(this.getStatus());
    });
  }

  // --- Durum ---------------------------------------------------------------------------

  private status(): AccountPairingState['status'] {
    if (!this.settingEnabled) return 'off';
    if (!this.remoteActive) return 'waiting-remote-access';
    if (!this.hasAccount) return 'no-account';
    if (this.blocked) return this.blocked;
    if (this.failing) return 'error';
    return 'active';
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  private resetRuntime(): void {
    this.etag = null;
    this.publishedEntry = null;
    this.publishedAt = 0;
    this.blocked = null;
    this.failing = false;
    this.failures = 0;
    this.retracted = false;
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (this.disposed) return;
    const scheduler = this.deps.scheduler ?? defaultAccountPairingScheduler;
    this.cancelTimer = scheduler(() => {
      this.cancelTimer = undefined;
      void this.exclusive(() => this.tick()).catch(() => {});
    }, delayMs);
  }

  private nextDelay(): number {
    const base = this.deps.pollMs ?? ACCOUNT_PAIRING_POLL_MS;
    if (this.failures === 0) return base;
    return Math.min(base * 2 ** this.failures, ACCOUNT_PAIRING_MAX_BACKOFF_MS);
  }

  // --- Ana döngü -----------------------------------------------------------------------

  /** Ayarı ve mobil erişimi okur; gerekirse yayınlar/yoklar/geri çeker ve sonrakini planlar. */
  private async tick(): Promise<void> {
    this.clearTimer();
    if (this.disposed) return;
    const settings = await this.deps.host.getSettings();
    const info = await this.deps.host.getHostInfo();
    this.settingEnabled = settings.enabled;
    this.remoteActive = info.remoteEnabled && info.listening && info.port !== null;
    if (!this.settingEnabled || !this.remoteActive) {
      this.failing = false;
      if (this.settingEnabled) await this.retract(settings, info.hostId);
      return;
    }
    // `missing-scope`/`unauthorized`: kullanıcı ayarı değiştirene ya da "Şimdi kontrol et"e basana dek dur.
    if (this.blocked) return;
    await this.pollOnce(settings, info);
    if (!this.blocked) this.schedule(this.nextDelay());
  }

  private async resolveStore(): Promise<{
    store: AccountPairingStore;
    account: AccountPairingAccount;
  } | null> {
    const account = await this.deps.getAccount();
    this.hasAccount = account !== null;
    this.login = account?.login ?? null;
    if (!account) return null;
    const store = createAccountPairingStore({
      getToken: () => account.accessToken,
      apiBaseUrl: account.apiBaseUrl,
      http: this.deps.http ?? fetchAccountPairingHttp,
    });
    return { store, account };
  }

  private async pollOnce(
    settings: StoredAccountPairing,
    info: Awaited<ReturnType<AccountPairingHostPort['getHostInfo']>>
  ): Promise<void> {
    try {
      const resolved = await this.resolveStore();
      if (!resolved) {
        this.failing = false;
        return;
      }
      const { store } = resolved;
      const keyed = await this.ensureKey(settings);
      const publicKey = keyed.publicKey;
      if (!publicKey) throw new AccountPairingStoreError('invalid-response');
      if (keyed !== settings) await this.deps.host.saveSettings({ ...keyed, enabled: true });
      let gistId = keyed.gistId;
      const entry = this.currentEntry(info, publicKey);
      const now = this.now();
      let document: AccountPairingDocument | null = null;
      let needPublish = true;
      if (gistId) {
        // Yerel adres/port değiştiyse eski ETag'e güvenilmez; koşulsuz okunur.
        const localChanged = this.publishedEntry !== null && !sameEntry(this.publishedEntry, entry);
        const read = await store.read(gistId, localChanged ? null : this.etag);
        if (read.status === 'not-modified') {
          needPublish = now - this.publishedAt > ACCOUNT_PAIRING_REPUBLISH_MS;
          if (!needPublish) {
            this.markChecked();
            return;
          }
        } else if (read.status === 'ok') {
          this.etag = read.etag;
          document = read.document;
          const own = document.hosts.find((host) => host.id === info.hostId);
          // Belge zaten güncelse yeniden yazılmaz.
          needPublish =
            !own || !sameEntry(own, entry) || now - own.updatedAt > ACCOUNT_PAIRING_REPUBLISH_MS;
          if (own && !needPublish) {
            this.publishedEntry = own;
            this.publishedAt = own.updatedAt;
          }
        }
      }
      if (needPublish) {
        const published = await this.publish(store, gistId, entry);
        if (!published) {
          this.failing = true;
          return;
        }
        document = published.document;
        gistId = published.gistId;
        if (gistId !== keyed.gistId) {
          await this.deps.host.saveSettings({ ...keyed, enabled: true, gistId });
        }
      }
      if (gistId && document) {
        await this.handleRequests(store, gistId, document, info.hostId, publicKey);
      }
      this.markChecked();
    } catch (error) {
      this.handleFailure(error);
    }
  }

  private markChecked(): void {
    this.lastCheckedAt = this.now();
    this.failing = false;
    this.failures = 0;
  }

  private handleFailure(error: unknown): void {
    const kind = classify(error);
    this.lastCheckedAt = this.now();
    if (kind === 'missing-scope' || kind === 'unauthorized') {
      this.blocked = kind;
      this.failing = false;
      this.clearTimer();
    } else {
      this.failing = true;
      this.failures += 1;
    }
    // Hata nesnesi yalnızca kodunu verir; belirteç ya da adres içermez.
    this.deps.logger.warn('Account pairing check failed', {
      reason: error instanceof AccountPairingStoreError ? error.code : 'unexpected',
    });
  }

  private currentEntry(
    info: Awaited<ReturnType<AccountPairingHostPort['getHostInfo']>>,
    publicKey: string
  ): AccountPairingHost {
    return {
      id: info.hostId,
      name: info.hostName.trim().slice(0, 64) || 'Orkestra',
      addresses: info.addresses.slice(0, 6),
      port: info.port ?? 0,
      publicKey,
      updatedAt: this.now(),
    };
  }

  /** Kaydı belgeye yazar; adres yoksa (telefon bağlanamaz) yazmaz. */
  private async publish(
    store: AccountPairingStore,
    gistId: string | null,
    entry: AccountPairingHost
  ): Promise<{ gistId: string; document: AccountPairingDocument } | null> {
    if (entry.addresses.length === 0 || entry.port < 1) {
      this.deps.logger.warn('Account pairing has nothing to publish: no reachable address');
      return null;
    }
    const result = await store.update({
      gistId,
      create: true,
      change: (document) => withAccountPairingHost(document, entry),
      verify: (document) =>
        document.hosts.some((host) => host.id === entry.id && sameEntry(host, entry)),
    });
    if (!result) return null;
    this.etag = result.etag;
    this.publishedEntry = entry;
    this.publishedAt = this.now();
    this.retracted = false;
    return { gistId: result.gistId, document: result.document };
  }

  /** Bu masaüstüne yönelik istekleri işler; tek bir kötü istek diğerlerini durdurmaz. */
  private async handleRequests(
    store: AccountPairingStore,
    gistId: string,
    document: AccountPairingDocument,
    hostId: string,
    publicKey: string
  ): Promise<void> {
    const mine = document.requests.filter((request) => request.hostId === hostId);
    if (mine.length === 0) return;
    // İşlem yarıda kalırsa bir sonraki yoklama koşulsuz okusun.
    this.etag = null;
    const now = this.now();
    const privateKey = await this.loadPrivateKey();
    const remove = new Set<string>();
    let retry = false;

    for (const request of mine) {
      if (isAccountPairingRequestExpired(request, now)) {
        remove.add(requestKey(request));
        continue;
      }
      try {
        if (!privateKey) {
          retry = true;
          continue;
        }
        let derived: Uint8Array;
        try {
          derived = await deriveAccountPairingSecret({
            role: 'host',
            privateKey,
            ownPublicKey: publicKey,
            peerPublicKey: request.publicKey,
            hostId,
            deviceId: request.deviceId,
          });
        } catch {
          // Geçersiz anahtar: istek reddedilir ve belgeden silinir.
          this.deps.logger.warn('Account pairing request rejected', {
            deviceId: request.deviceId,
            reason: 'bad-key',
          });
          remove.add(requestKey(request));
          continue;
        }
        const registered = await this.deps.host.registerDerivedDevice({
          deviceId: request.deviceId,
          name: request.name,
          platform: request.platform,
          secret: derived,
        });
        if (registered.success) this.lastPairedDeviceName = request.name;
        else {
          this.deps.logger.info('Account pairing request not registered', {
            deviceId: request.deviceId,
            reason: registered.error.type,
          });
        }
        // Başarılı ya da kalıcı olarak reddedilen (zaten var, sınır) istek belgeden silinir.
        remove.add(requestKey(request));
      } catch {
        // Beklenmeyen hata (ör. sır deposu): istek belgede kalır, sonraki yoklamada yeniden denenir.
        retry = true;
      }
    }

    if (remove.size > 0) {
      const result = await store.update({
        gistId,
        create: false,
        change: (current) =>
          withoutAccountPairingRequests(
            current,
            current.requests
              .filter((entry) => entry.hostId === hostId && remove.has(requestKey(entry)))
              .map((entry) => entry.deviceId)
          ),
        verify: (current) =>
          !current.requests.some(
            (entry) => entry.hostId === hostId && remove.has(requestKey(entry))
          ),
      });
      this.etag = result?.etag ?? null;
    }
    // Belgede işlenmemiş istek kaldıysa sonraki yoklama koşulsuz okusun (süre dolumu da silinsin).
    if (retry) this.etag = null;
  }

  /** Kendi kaydını (ve ona yönelmiş istekleri) belgeden siler; belge yoksa oluşturmaz. */
  private async retract(settings: StoredAccountPairing, hostId: string): Promise<void> {
    if (this.retracted || !settings.gistId) return;
    try {
      const resolved = await this.resolveStore();
      if (!resolved) return;
      const read = await resolved.store.read(settings.gistId);
      if (read.status !== 'ok') {
        this.retracted = true;
        return;
      }
      if (read.document.hosts.some((host) => host.id === hostId)) {
        await resolved.store.update({
          gistId: settings.gistId,
          create: false,
          change: (document) => withoutAccountPairingHost(document, hostId),
          verify: (document) => !document.hosts.some((host) => host.id === hostId),
        });
      }
      this.retracted = true;
      this.publishedEntry = null;
      this.etag = null;
    } catch (error) {
      // En iyi çaba: kayıt kalırsa telefon bağlanamaz, bir sonraki açılışta düzelir.
      this.deps.logger.warn('Account pairing entry could not be removed', {
        reason: error instanceof AccountPairingStoreError ? error.code : 'unexpected',
      });
    }
  }

  // --- Anahtar -------------------------------------------------------------------------

  /** Özel anahtar yoksa (ya da açık anahtar kayıtlı değilse) yeni çift üretir. */
  private async ensureKey(settings: StoredAccountPairing): Promise<StoredAccountPairing> {
    if (settings.publicKey && (await this.loadPrivateKey())) return settings;
    const pair = await generateAccountPairingKeyPair();
    await this.deps.secrets.setSecret(
      ACCOUNT_PAIRING_HOST_KEY_SECRET,
      secret(JSON.stringify(pair.privateKey), 'remote-access')
    );
    // Yeni anahtar: eski yayın geçersiz, belge yeniden yazılmalı.
    this.publishedEntry = null;
    this.etag = null;
    return { ...settings, publicKey: pair.publicKey };
  }

  private async loadPrivateKey(): Promise<JsonWebKey | null> {
    const stored = await this.deps.secrets.getSecret(ACCOUNT_PAIRING_HOST_KEY_SECRET);
    if (!stored) return null;
    try {
      const parsed: unknown = JSON.parse(stored.expose());
      return typeof parsed === 'object' && parsed !== null ? (parsed as JsonWebKey) : null;
    } catch {
      return null;
    }
  }
}

function classify(error: unknown): FailureKind {
  if (error instanceof AccountPairingStoreError) {
    if (error.code === 'missing-scope' || error.code === 'unauthorized') return error.code;
  }
  return 'transient';
}
