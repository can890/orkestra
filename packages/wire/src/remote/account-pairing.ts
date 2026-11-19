import { base64UrlDecode, base64UrlEncode, utf8Encode } from './bytes';
import { isRemoteDeviceId, REMOTE_SECRET_BYTES } from './protocol';

/**
 * Hesap üzerinden eşleşme (QR'sız): masaüstü ve telefon aynı GitHub hesabına bağlıyken, o hesabın
 * yalnızca sahibince yazılabilen bir belgede (gizli bir gist) açık anahtarlarını değiş tokuş eder.
 *
 * Güven modeli:
 * - Belgeye yalnızca hesap sahibi yazabilir; telefonun isteği belgede görünüyorsa aynı hesaptan
 *   gelmiştir. Masaüstü belgeyi her zaman kendi kimlik doğrulamalı API çağrısıyla okur.
 * - Belge gizli değildir (adresini bilen okuyabilir). Bu yüzden içine yalnızca açık anahtarlar ve
 *   yerel ağ adresleri girer; eşleştirme sırrı hiçbir zaman belgeye ya da ağa yazılmaz.
 * - Sır iki uçta ayrı ayrı türetilir: ECDH(P-256) → HKDF-SHA256. Türetilen 32 bayt, QR ile
 *   paylaşılan sırla aynı yerde ve aynı el sıkışmada kullanılır (`deriveChannelKeys`).
 */

export const ACCOUNT_PAIRING_KIND = 'orkestra-account-pairing';
export const ACCOUNT_PAIRING_VERSION = 1;
/** Buluşma belgesinin gist içindeki dosya adı; gist bu adla bulunur. */
export const ACCOUNT_PAIRING_FILE = 'orkestra-pairing.json';
export const ACCOUNT_PAIRING_DESCRIPTION =
  'Orkestra device pairing. Holds public keys and local network addresses only. Safe to delete.';
/** Bir eşleşme isteği bu süreden eskiyse yok sayılır ve belgeden silinir. */
export const ACCOUNT_PAIRING_REQUEST_TTL_MS = 10 * 60_000;
export const ACCOUNT_PAIRING_MAX_HOSTS = 8;
export const ACCOUNT_PAIRING_MAX_REQUESTS = 8;
export const ACCOUNT_PAIRING_MAX_DOCUMENT_CHARS = 32_768;

const KDF_INFO = 'orkestra-remote/v1 account-pairing';
/** Sıkıştırılmamış P-256 noktası: 0x04 ‖ X(32) ‖ Y(32). */
const PUBLIC_KEY_BYTES = 65;
const MAX_NAME_CHARS = 64;
const MAX_ADDRESSES = 6;
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;

export type AccountPairingHost = {
  /** Masaüstünün kalıcı kimliği (uzak erişimdeki `hostId`). */
  id: string;
  name: string;
  /** Telefonun deneyeceği adresler (yerel ağ, ardından Tailscale). */
  addresses: string[];
  port: number;
  /** base64url, sıkıştırılmamış P-256 açık anahtarı. */
  publicKey: string;
  updatedAt: number;
};

export type AccountPairingRequest = {
  deviceId: string;
  /** İsteğin yöneldiği masaüstü. */
  hostId: string;
  name: string;
  platform: string;
  publicKey: string;
  createdAt: number;
};

export type AccountPairingDocument = {
  k: typeof ACCOUNT_PAIRING_KIND;
  v: typeof ACCOUNT_PAIRING_VERSION;
  hosts: AccountPairingHost[];
  requests: AccountPairingRequest[];
};

export type AccountPairingKeyPair = {
  /** base64url açık anahtar; belgeye yazılır. */
  publicKey: string;
  /** Özel anahtar (JWK); yalnızca cihazın güvenli deposunda saklanır. */
  privateKey: JsonWebKey;
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^[0-9A-Fa-f:]{2,45}$/;
const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  if (IPV4.test(value)) return value.split('.').every((part) => Number(part) <= 255);
  if (value.includes(':')) return IPV6.test(value);
  return HOSTNAME.test(value);
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_CHARS;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Biçim denetimi; noktanın eğri üzerinde olduğunu `deriveAccountPairingSecret` doğrular. */
export function isAccountPairingPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100) return false;
  const bytes = base64UrlDecode(value);
  return bytes !== null && bytes.byteLength === PUBLIC_KEY_BYTES && bytes[0] === 0x04;
}

function parseHost(value: unknown): AccountPairingHost | null {
  if (!isRecord(value)) return null;
  const { id, name, addresses, port, publicKey, updatedAt } = value;
  if (!isRemoteDeviceId(id) || !isName(name) || !isAccountPairingPublicKey(publicKey)) return null;
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > MAX_ADDRESSES) {
    return null;
  }
  if (!addresses.every(isAddress)) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!isTimestamp(updatedAt)) return null;
  return { id, name, addresses: [...addresses], port, publicKey, updatedAt };
}

function parseRequest(value: unknown): AccountPairingRequest | null {
  if (!isRecord(value)) return null;
  const { deviceId, hostId, name, platform, publicKey, createdAt } = value;
  if (!isRemoteDeviceId(deviceId) || !isRemoteDeviceId(hostId)) return null;
  if (!isName(name) || !isName(platform) || !isAccountPairingPublicKey(publicKey)) return null;
  if (!isTimestamp(createdAt)) return null;
  return { deviceId, hostId, name, platform, publicKey, createdAt };
}

export function emptyAccountPairingDocument(): AccountPairingDocument {
  return { k: ACCOUNT_PAIRING_KIND, v: ACCOUNT_PAIRING_VERSION, hosts: [], requests: [] };
}

/**
 * Belgeyi ayrıştırır. Tür ya da sürüm uymuyorsa `null`; tek tek geçersiz kayıtlar atılır, böylece
 * bozuk bir istek diğer cihazların eşleşmesini engellemez. Fazla kayıtlar da kırpılır.
 */
export function parseAccountPairingDocument(text: unknown): AccountPairingDocument | null {
  if (typeof text !== 'string' || text.length > ACCOUNT_PAIRING_MAX_DOCUMENT_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.k !== ACCOUNT_PAIRING_KIND || raw.v !== ACCOUNT_PAIRING_VERSION) {
    return null;
  }
  const hosts = (Array.isArray(raw.hosts) ? raw.hosts : [])
    .map(parseHost)
    .filter((host): host is AccountPairingHost => host !== null);
  const requests = (Array.isArray(raw.requests) ? raw.requests : [])
    .map(parseRequest)
    .filter((request): request is AccountPairingRequest => request !== null);
  return {
    k: ACCOUNT_PAIRING_KIND,
    v: ACCOUNT_PAIRING_VERSION,
    hosts: newest(
      uniqueBy(hosts, (host) => host.id),
      (host) => host.updatedAt
    ).slice(0, ACCOUNT_PAIRING_MAX_HOSTS),
    requests: newest(
      uniqueBy(requests, (request) => request.deviceId),
      (r) => r.createdAt
    ).slice(0, ACCOUNT_PAIRING_MAX_REQUESTS),
  };
}

export function serializeAccountPairingDocument(document: AccountPairingDocument): string {
  return `${JSON.stringify(document, null, 1)}\n`;
}

/** Aynı anahtarlı kayıtlardan sonuncusunu tutar. */
function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) seen.set(key(item), item);
  return [...seen.values()];
}

function newest<T>(items: readonly T[], time: (item: T) => number): T[] {
  return [...items].sort((a, b) => time(b) - time(a));
}

/** Masaüstü kaydını ekler ya da günceller. */
export function withAccountPairingHost(
  document: AccountPairingDocument,
  host: AccountPairingHost
): AccountPairingDocument {
  const others = document.hosts.filter((entry) => entry.id !== host.id);
  return {
    ...document,
    hosts: newest([host, ...others], (entry) => entry.updatedAt).slice(
      0,
      ACCOUNT_PAIRING_MAX_HOSTS
    ),
  };
}

/** Masaüstü kaydını ve ona yönelmiş istekleri siler. */
export function withoutAccountPairingHost(
  document: AccountPairingDocument,
  hostId: string
): AccountPairingDocument {
  return {
    ...document,
    hosts: document.hosts.filter((entry) => entry.id !== hostId),
    requests: document.requests.filter((entry) => entry.hostId !== hostId),
  };
}

/** Telefonun eşleşme isteğini ekler; aynı cihazın eski isteğinin yerine geçer. */
export function withAccountPairingRequest(
  document: AccountPairingDocument,
  request: AccountPairingRequest
): AccountPairingDocument {
  const others = document.requests.filter((entry) => entry.deviceId !== request.deviceId);
  return {
    ...document,
    requests: newest([request, ...others], (entry) => entry.createdAt).slice(
      0,
      ACCOUNT_PAIRING_MAX_REQUESTS
    ),
  };
}

export function withoutAccountPairingRequests(
  document: AccountPairingDocument,
  deviceIds: readonly string[]
): AccountPairingDocument {
  const drop = new Set(deviceIds);
  return { ...document, requests: document.requests.filter((entry) => !drop.has(entry.deviceId)) };
}

/** Süresi dolmuş (ya da saati tutarsız) bir istek mi? İki yönde de aynı tolerans uygulanır. */
export function isAccountPairingRequestExpired(
  request: AccountPairingRequest,
  now: number
): boolean {
  return Math.abs(now - request.createdAt) > ACCOUNT_PAIRING_REQUEST_TTL_MS;
}

function subtle(): SubtleCrypto {
  const impl = globalThis.crypto?.subtle;
  if (!impl) throw new Error('WebCrypto (crypto.subtle) is not available');
  return impl;
}

function view(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
}

/** Yeni bir ECDH(P-256) anahtar çifti üretir. Özel anahtar yalnızca güvenli depoya yazılmalıdır. */
export async function generateAccountPairingKeyPair(): Promise<AccountPairingKeyPair> {
  const pair = await subtle().generateKey(CURVE, true, ['deriveBits']);
  const [publicKey, privateKey] = await Promise.all([
    subtle().exportKey('raw', pair.publicKey),
    subtle().exportKey('jwk', pair.privateKey),
  ]);
  return { publicKey: base64UrlEncode(new Uint8Array(publicKey)), privateKey };
}

export type AccountPairingSecretInput = {
  /** Bu ucun rolü; iki uç da aynı girdiyi (masaüstü anahtarı, cihaz anahtarı) aynı sırada kullanır. */
  role: 'host' | 'device';
  privateKey: JsonWebKey;
  ownPublicKey: string;
  peerPublicKey: string;
  hostId: string;
  deviceId: string;
};

/**
 * İki ucun ayrı ayrı hesapladığı 32 baytlık eşleştirme sırrı.
 * ikm = ECDH(özel, karşı açık); salt = hostId ‖ deviceId ‖ masaüstü anahtarı ‖ cihaz anahtarı;
 * info = protokol etiketi. Karşı anahtar eğri üzerinde değilse ya da kimlikler geçersizse hata verir;
 * hata iletisine anahtar girmez.
 */
export async function deriveAccountPairingSecret(
  input: AccountPairingSecretInput
): Promise<Uint8Array> {
  if (!isRemoteDeviceId(input.hostId) || !isRemoteDeviceId(input.deviceId)) {
    throw new Error('Invalid pairing identifiers');
  }
  if (
    !isAccountPairingPublicKey(input.ownPublicKey) ||
    !isAccountPairingPublicKey(input.peerPublicKey)
  ) {
    throw new Error('Invalid pairing public key');
  }
  if (input.ownPublicKey === input.peerPublicKey) throw new Error('Invalid pairing public key');
  let shared: ArrayBuffer;
  try {
    const [privateKey, peer] = await Promise.all([
      subtle().importKey('jwk', input.privateKey, CURVE, false, ['deriveBits']),
      subtle().importKey('raw', view(base64UrlDecode(input.peerPublicKey)!), CURVE, false, []),
    ]);
    shared = await subtle().deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  } catch {
    throw new Error('Pairing key agreement failed');
  }
  const hostKey = input.role === 'host' ? input.ownPublicKey : input.peerPublicKey;
  const deviceKey = input.role === 'host' ? input.peerPublicKey : input.ownPublicKey;
  const base = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: view(utf8Encode([input.hostId, input.deviceId, hostKey, deviceKey].join('\n'))),
      info: view(utf8Encode(KDF_INFO)),
    },
    base,
    REMOTE_SECRET_BYTES * 8
  );
  return new Uint8Array(bits);
}
