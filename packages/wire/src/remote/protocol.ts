import type { WireMessage } from '../api/protocol';

/**
 * Uzak erişim (mobil) protokolü: Wire mesajlarını WebSocket üzerinde, uygulama katmanında
 * şifreleyerek taşır. Ayrıntılı şartname: `agents/architecture/remote-access.md`.
 */

export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_WS_PATH = '/orkestra-remote/v1';

/** Eşleştirme sırrının ham bayt uzunluğu. */
export const REMOTE_SECRET_BYTES = 32;
/** `clientNonce` ve `serverNonce` bayt uzunluğu. */
export const REMOTE_NONCE_BYTES = 32;
/** Şifreli çerçevenin (sayaç + şifreli metin + etiket) üst sınırı. */
export const REMOTE_MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** El sıkışma (hello) metin çerçevesinin üst sınırı. */
export const REMOTE_MAX_HELLO_BYTES = 512;

export const REMOTE_KDF_INFO_C2S = 'orkestra-remote/v1 c2s';
export const REMOTE_KDF_INFO_S2C = 'orkestra-remote/v1 s2c';
/** AES-GCM nonce'unun ilk 4 baytı (big-endian): istemciden sunucuya. */
export const REMOTE_DIRECTION_C2S = 0x00000001;
/** AES-GCM nonce'unun ilk 4 baytı (big-endian): sunucudan istemciye. */
export const REMOTE_DIRECTION_S2C = 0x00000002;

/** WebSocket kapatma kodları (4000-4999 uygulama aralığı). */
export const REMOTE_CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL: 4400,
  AUTH_FAILED: 4401,
  REVOKED: 4403,
  HANDSHAKE_TIMEOUT: 4408,
  REPLACED: 4409,
  TOO_LARGE: 4413,
  VERSION_UNSUPPORTED: 4426,
  RATE_LIMITED: 4429,
  BUSY: 4503,
} as const;
export type RemoteCloseCode = (typeof REMOTE_CLOSE)[keyof typeof REMOTE_CLOSE];

export type RemoteErrorCode =
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'VERSION_UNSUPPORTED'
  | 'PROTOCOL'
  | 'BUSY';

/** İstemci → sunucu, ilk metin çerçevesi. */
export type RemoteHello = {
  t: 'hello';
  v: number;
  deviceId: string;
  /** base64url, 32 bayt. */
  clientNonce: string;
};

/** Sunucu → istemci, hello yanıtı. */
export type RemoteChallenge = {
  t: 'challenge';
  v: number;
  /** base64url, 32 bayt. */
  serverNonce: string;
};

/** Şifre çözülemeden önce gönderilen tek hata biçimi (düz metin çerçeve). */
export type RemoteErrorFrame = {
  t: 'error';
  code: RemoteErrorCode;
  message: string;
  retryAfterMs?: number;
};

/** İstemcinin ilk şifreli çerçevesi (sayaç 0). */
export type RemoteAuthPayload = {
  t: 'auth';
  v: number;
  deviceId: string;
  clientName?: string;
  platform?: string;
};

/** Sunucunun ilk şifreli çerçevesi (sayaç 0); istemci bunu doğrulayana dek Wire trafiği başlamaz. */
export type RemoteWelcomePayload = {
  t: 'welcome';
  v: number;
  hostId: string;
  hostName: string;
  /** Sunucunun şu anki aday adresleri; istemci kayıtlı adreslerini güncelleyebilir. */
  addresses: string[];
  port: number;
};

/** El sıkışma sonrası her şifreli çerçevenin düz metni (UTF-8 JSON). */
export type RemoteEnvelope = { t: 'wire'; m: WireMessage } | { t: 'ping' } | { t: 'pong' };

export type RemoteSocketData = string | Uint8Array;

/**
 * WebSocket'in küçük, test edilebilir yüzü. Tarayıcı `WebSocket`'i, Node `ws` ve bellek içi
 * test çifti bunu uygular.
 */
export type RemoteSocket = {
  send(data: RemoteSocketData): void;
  close(code: number, reason?: string): void;
  /** Metin için `string`, ikili için `Uint8Array` iletilir. */
  onMessage(cb: (data: RemoteSocketData) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
};

export function isRemoteDeviceId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

export function remoteWebSocketUrl(address: string, port: number): string {
  const host = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
  return `ws://${host}:${port}${REMOTE_WS_PATH}`;
}
