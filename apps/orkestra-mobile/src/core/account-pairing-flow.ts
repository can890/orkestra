import {
  AccountPairingStoreError,
  base64UrlEncode,
  connectRemoteTransport,
  deriveAccountPairingSecret,
  generateAccountPairingKeyPair,
  RemoteHandshakeError,
  withAccountPairingRequest,
  withoutAccountPairingRequests,
  type AccountPairingHost,
  type AccountPairingRequest,
  type AccountPairingStore,
  type RemoteClientOptions,
  type RemoteClientTransport,
} from '@orkestra/wire/remote';
import { isValidAddress, PAIRING_KIND, PAIRING_VERSION, parsePairingPayload } from './pairing';
import type { PairingPayload } from './pairing';

/**
 * GitHub hesabı üzerinden (QR'sız) eşleşme. Belirteç ve özel anahtar yalnızca bu akışın bellek
 * değişkenlerinde yaşar; kalıcı olan tek şey, bağlantı başarılı olunca `AppSession.pair`ın yazdığı
 * olağan eşleşme kaydıdır (QR eşleşmesiyle aynı yol). Hiçbir ileti belirteç/anahtar/sır içermez.
 */
export const NO_HOST_MESSAGE =
  "Bu hesapta eşleşmeye açık bir bilgisayar yok. Bilgisayarda Ayarlar → Mobil erişim → GitHub hesabıyla eşleş'i açın.";
export const TIMEOUT_MESSAGE =
  "Bilgisayar eşleşmeyi onaylamadı. Bilgisayarın açık, aynı Wi-Fi'da (ya da Tailscale'de) ve GitHub hesabıyla eşleşmenin açık olduğundan emin olun.";

export const PAIRING_WAIT_MS = 3 * 60_000;
export const PAIRING_RETRY_MS = 5_000;
const FALLBACK_DIAL_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 4_000;
const MAX_NAME_CHARS = 64;

export function describeStoreError(error: unknown): string {
  if (error instanceof AccountPairingStoreError) {
    switch (error.code) {
      case 'missing-scope':
        return 'GitHub izni eksik; yeniden giriş yapın.';
      case 'unauthorized':
        return 'GitHub oturumu geçersiz; yeniden giriş yapın.';
      case 'rate-limited':
        return 'GitHub istek sınırına takıldı; birkaç dakika sonra deneyin.';
      case 'network':
        return "GitHub'a ulaşılamadı; internet bağlantısını kontrol edin.";
      default:
        return 'GitHub ile iletişim kurulamadı; tekrar deneyin.';
    }
  }
  return 'Eşleşme tamamlanamadı; tekrar deneyin.';
}

export type DiscoverResult =
  | { kind: 'ready'; gistId: string; hosts: AccountPairingHost[] }
  | { kind: 'no-host'; message: string }
  | { kind: 'error'; message: string };

/** Hesaptaki buluşma belgesini bulur ve eşleşmeye açık masaüstlerini listeler. */
export async function discoverHosts(store: AccountPairingStore): Promise<DiscoverResult> {
  try {
    const gistId = await store.find();
    if (!gistId) return { kind: 'no-host', message: NO_HOST_MESSAGE };
    const read = await store.read(gistId);
    if (read.status !== 'ok') return { kind: 'no-host', message: NO_HOST_MESSAGE };
    const hosts = read.document.hosts
      .map((host) => ({ ...host, addresses: host.addresses.filter(isValidAddress) }))
      .filter((host) => host.addresses.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (hosts.length === 0) return { kind: 'no-host', message: NO_HOST_MESSAGE };
    return { kind: 'ready', gistId, hosts };
  } catch (error) {
    return { kind: 'error', message: describeStoreError(error) };
  }
}

export type PairResult =
  | { kind: 'paired' }
  | { kind: 'timeout'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

export type PairWithHostOptions = {
  store: AccountPairingStore;
  gistId: string;
  host: AccountPairingHost;
  /** `AppSession.pair`: QR eşleşmesiyle aynı yol. */
  pair: (payload: PairingPayload) => Promise<void>;
  deviceName: string;
  platform: string;
  signal: AbortSignal;
  /** Bu aşamada masaüstü bekleniyor (arayüz durumu için). */
  onWaiting?: () => void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  randomId?: () => string;
  dial?: (options: RemoteClientOptions) => Promise<RemoteClientTransport>;
  waitMs?: number;
  retryMs?: number;
  /** İstek belgeden silinmediyse bile bu aralıkla bağlanmayı dener. */
  fallbackDialMs?: number;
};

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * İstek yazar, sırrı türetir ve masaüstü cihazı kaydedene kadar (en çok 3 dakika) bağlanmayı dener.
 * Kayıt gelmeden el sıkışma `AUTH_FAILED` ile reddedilir; bu "henüz değil" sayılır.
 */
export async function pairWithHost(options: PairWithHostOptions): Promise<PairResult> {
  const { store, host, signal } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const dial = options.dial ?? connectRemoteTransport;
  const deviceId = (options.randomId ?? (() => globalThis.crypto.randomUUID()))();

  let secret: Uint8Array;
  let payload: PairingPayload;
  let etag: string | null = null;
  try {
    const keys = await generateAccountPairingKeyPair();
    const request: AccountPairingRequest = {
      deviceId,
      hostId: host.id,
      name: options.deviceName.slice(0, MAX_NAME_CHARS),
      platform: options.platform,
      publicKey: keys.publicKey,
      createdAt: now(),
    };
    const written = await store.update({
      gistId: options.gistId,
      change: (document) => withAccountPairingRequest(document, request),
      verify: (document) => document.requests.some((entry) => entry.deviceId === deviceId),
    });
    if (!written) return { kind: 'error', message: NO_HOST_MESSAGE };
    etag = written.etag;
    secret = await deriveAccountPairingSecret({
      role: 'device',
      privateKey: keys.privateKey,
      ownPublicKey: keys.publicKey,
      peerPublicKey: host.publicKey,
      hostId: host.id,
      deviceId,
    });
    // QR yüküyle aynı doğrulamadan geçirilir; böylece kayıt tam olarak QR eşleşmesindeki biçimde olur.
    const parsed = parsePairingPayload(
      JSON.stringify({
        k: PAIRING_KIND,
        v: PAIRING_VERSION,
        h: host.id,
        n: host.name.slice(0, MAX_NAME_CHARS),
        a: host.addresses,
        p: host.port,
        d: deviceId,
        s: base64UrlEncode(secret),
      })
    );
    if (!parsed.ok) {
      await removeRequest(store, options.gistId, deviceId);
      return { kind: 'error', message: 'Bilgisayarın eşleşme bilgisi geçersiz.' };
    }
    payload = parsed.payload;
  } catch (error) {
    return { kind: 'error', message: describeStoreError(error) };
  }
  if (signal.aborted) {
    await removeRequest(store, options.gistId, deviceId);
    return { kind: 'cancelled' };
  }

  options.onWaiting?.();
  const waitMs = options.waitMs ?? PAIRING_WAIT_MS;
  const deadline = now() + waitMs;
  const fallbackMs = options.fallbackDialMs ?? FALLBACK_DIAL_MS;
  let requestGone = false;
  let lastDialAt = now();
  while (!signal.aborted && now() < deadline) {
    // Masaüstü isteği kaydedip belgeden sildiğinde bağlanmayı dener. Kayıt gelmeden yapılan her
    // başarısız el sıkışma masaüstünün hız sınırına işlenir (5 hata → kilit), bu yüzden belge
    // izlenir; ETag'li okuma (304) GitHub hız sınırına sayılmaz.
    if (!requestGone) {
      try {
        const read = await store.read(options.gistId, etag);
        if (read.status === 'ok') {
          etag = read.etag;
          requestGone = !read.document.requests.some((entry) => entry.deviceId === deviceId);
        }
      } catch (error) {
        if (
          error instanceof AccountPairingStoreError &&
          (error.code === 'unauthorized' || error.code === 'missing-scope')
        ) {
          return { kind: 'error', message: describeStoreError(error) };
        }
        // Geçici hata: sonraki turda yeniden denenir.
      }
    }
    let pause = options.retryMs ?? PAIRING_RETRY_MS;
    // Belge izlenemese ya da masaüstü isteği silmese de seyrek aralıklarla bağlanmayı dener.
    if (requestGone || now() - lastDialAt >= fallbackMs) {
      lastDialAt = now();
      const outcome = await tryConnect(payload, secret, dial, signal);
      if (outcome.kind === 'connected') {
        try {
          await options.pair(payload);
        } catch {
          return {
            kind: 'error',
            message: 'Eşleştirme kaydı cihazın güvenli deposuna yazılamadı.',
          };
        }
        return { kind: 'paired' };
      }
      if (outcome.kind === 'fatal') {
        await removeRequest(store, options.gistId, deviceId);
        return { kind: 'error', message: outcome.message };
      }
      pause = Math.max(pause, outcome.waitMs);
    }
    await sleep(Math.max(0, Math.min(pause, deadline - now())), signal);
  }
  await removeRequest(store, options.gistId, deviceId);
  if (signal.aborted) return { kind: 'cancelled' };
  return { kind: 'timeout', message: TIMEOUT_MESSAGE };
}

type ConnectOutcome =
  | { kind: 'connected' }
  | { kind: 'not-yet'; waitMs: number }
  | { kind: 'fatal'; message: string };

/** Her adresi sırayla dener; başarılı el sıkışma sırrın doğru olduğunun kanıtıdır. */
async function tryConnect(
  payload: PairingPayload,
  secret: Uint8Array,
  dial: NonNullable<PairWithHostOptions['dial']>,
  signal: AbortSignal
): Promise<ConnectOutcome> {
  let waitMs = 0;
  for (const address of payload.a) {
    if (signal.aborted) break;
    try {
      const transport = await dial({
        address,
        port: payload.p,
        deviceId: payload.d,
        secret,
        clientName: 'Android telefon',
        platform: 'android',
        handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
        pingIntervalMs: 0,
        idleTimeoutMs: 0,
      });
      // Yoklama bağlantısı kapatılır; kalıcı bağlantıyı `AppSession.pair` kurar.
      transport.close?.();
      return { kind: 'connected' };
    } catch (error) {
      if (error instanceof RemoteHandshakeError) {
        if (error.code === 'VERSION_UNSUPPORTED') {
          return {
            kind: 'fatal',
            message:
              'Bu sürüm masaüstüyle uyumlu değil. Mobil uygulamayı ya da masaüstünü güncelleyin.',
          };
        }
        // Masaüstü cihazı henüz kaydetmediyse AUTH_FAILED döner: "henüz değil".
        if (error.code === 'RATE_LIMITED') waitMs = Math.max(waitMs, error.retryAfterMs ?? 0);
      }
    }
  }
  return { kind: 'not-yet', waitMs: Math.min(waitMs, 60_000) };
}

async function removeRequest(
  store: AccountPairingStore,
  gistId: string,
  deviceId: string
): Promise<void> {
  try {
    await store.update({
      gistId,
      change: (document) => withoutAccountPairingRequests(document, [deviceId]),
      verify: (document) => !document.requests.some((entry) => entry.deviceId === deviceId),
    });
  } catch {
    // En iyi çaba: istek zaten 10 dakika sonra geçersiz sayılır.
  }
}
