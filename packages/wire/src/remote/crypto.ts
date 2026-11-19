import { concatBytes, utf8Encode } from './bytes';
import {
  REMOTE_DIRECTION_C2S,
  REMOTE_DIRECTION_S2C,
  REMOTE_KDF_INFO_C2S,
  REMOTE_KDF_INFO_S2C,
  REMOTE_MAX_FRAME_BYTES,
  REMOTE_NONCE_BYTES,
  REMOTE_SECRET_BYTES,
} from './protocol';

/**
 * Yalnızca standart WebCrypto yapıları: HKDF-SHA256 ve AES-256-GCM. Anahtarlar çıkarılamaz
 * (`extractable: false`) olarak türetilir; sır ve anahtarlar asla hata mesajına girmez.
 */

const COUNTER_BYTES = 8;
const TAG_BYTES = 16;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

export type RemoteRole = 'client' | 'server';

export type RemoteChannelKeys = {
  send: CryptoKey;
  receive: CryptoKey;
  sendDirection: number;
  receiveDirection: number;
};

function subtle(): SubtleCrypto {
  const impl = globalThis.crypto?.subtle;
  if (!impl) throw new Error('WebCrypto (crypto.subtle) is not available');
  return impl;
}

/** `Uint8Array<ArrayBufferLike>` → WebCrypto'nun beklediği `BufferSource` (tür uyumu için). */
function view(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
}

/**
 * salt = clientNonce ‖ serverNonce; info = yön etiketi (`REMOTE_KDF_INFO_*`);
 * HKDF-SHA256 → 256 bit AES-GCM anahtarı (yön başına bir tane).
 */
export async function deriveChannelKeys(
  role: RemoteRole,
  secret: Uint8Array,
  clientNonce: Uint8Array,
  serverNonce: Uint8Array
): Promise<RemoteChannelKeys> {
  if (secret.byteLength !== REMOTE_SECRET_BYTES) throw new Error('Invalid pairing secret length');
  if (
    clientNonce.byteLength !== REMOTE_NONCE_BYTES ||
    serverNonce.byteLength !== REMOTE_NONCE_BYTES
  ) {
    throw new Error('Invalid nonce length');
  }
  const base = await subtle().importKey('raw', view(secret), 'HKDF', false, ['deriveKey']);
  const salt = view(concatBytes(clientNonce, serverNonce));
  const derive = (info: string) =>
    subtle().deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: view(utf8Encode(info)) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  const [c2s, s2c] = await Promise.all([derive(REMOTE_KDF_INFO_C2S), derive(REMOTE_KDF_INFO_S2C)]);
  return role === 'client'
    ? {
        send: c2s,
        receive: s2c,
        sendDirection: REMOTE_DIRECTION_C2S,
        receiveDirection: REMOTE_DIRECTION_S2C,
      }
    : {
        send: s2c,
        receive: c2s,
        sendDirection: REMOTE_DIRECTION_S2C,
        receiveDirection: REMOTE_DIRECTION_C2S,
      };
}

function writeCounter(target: Uint8Array, offset: number, counter: number): void {
  const high = Math.floor(counter / 0x1_0000_0000);
  const low = counter >>> 0;
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, high);
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset + 4, low);
}

function readCounter(source: Uint8Array, offset: number): number {
  const dv = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const high = dv.getUint32(offset);
  const low = dv.getUint32(offset + 4);
  if (high > 0x1f_ffff) return -1; // 2^53 sınırının üstü
  return high * 0x1_0000_0000 + low;
}

/** nonce = yön (4 bayt, big-endian) ‖ sayaç (8 bayt, big-endian). */
function buildNonce(direction: number, counter: number): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setUint32(0, direction);
  writeCounter(nonce, 4, counter);
  return nonce;
}

export type FrameSealer = { seal(plaintext: Uint8Array): Promise<Uint8Array> };
export type FrameOpener = { open(frame: Uint8Array): Promise<Uint8Array> };

/**
 * Çerçeve = sayaç (8 bayt BE) ‖ AES-GCM(şifreli metin ‖ 16 bayt etiket); nonce yön ‖ sayaç,
 * AAD sayaç baytlarıdır. Sayaç 0'dan başlar ve her çerçevede 1 artar.
 *
 * `seal` sayacı ÇAĞRI ANINDA (eşzamanlı) atar; çağıran, dönen çerçeveleri sayaç sırasıyla
 * göndermekle yükümlüdür (bkz. `SecureChannel` içindeki gönderim kuyruğu).
 */
export function createFrameSealer(key: CryptoKey, direction: number): FrameSealer {
  let counter = 0;
  return {
    async seal(plaintext) {
      if (plaintext.byteLength + COUNTER_BYTES + TAG_BYTES > REMOTE_MAX_FRAME_BYTES) {
        throw new RemoteFrameTooLargeError();
      }
      const current = counter;
      if (current >= MAX_COUNTER) throw new Error('Frame counter exhausted');
      counter += 1;
      const header = new Uint8Array(COUNTER_BYTES);
      writeCounter(header, 0, current);
      const sealed = await subtle().encrypt(
        { name: 'AES-GCM', iv: buildNonce(direction, current), additionalData: header },
        key,
        view(plaintext)
      );
      return concatBytes(header, new Uint8Array(sealed));
    },
  };
}

/** Beklenen sayaçtan farklı (tekrar/sırasız) ya da doğrulanamayan çerçeve `RemoteFrameError` fırlatır. */
export function createFrameOpener(key: CryptoKey, direction: number): FrameOpener {
  let expected = 0;
  return {
    async open(frame) {
      if (
        frame.byteLength < COUNTER_BYTES + TAG_BYTES ||
        frame.byteLength > REMOTE_MAX_FRAME_BYTES
      ) {
        throw new RemoteFrameError('Malformed frame');
      }
      const counter = readCounter(frame, 0);
      if (counter !== expected) throw new RemoteFrameError('Unexpected frame counter');
      const header = frame.slice(0, COUNTER_BYTES);
      let plain: ArrayBuffer;
      try {
        plain = await subtle().decrypt(
          { name: 'AES-GCM', iv: buildNonce(direction, counter), additionalData: view(header) },
          key,
          view(frame.subarray(COUNTER_BYTES))
        );
      } catch {
        throw new RemoteFrameError('Frame authentication failed');
      }
      expected += 1;
      return new Uint8Array(plain);
    },
  };
}

export class RemoteFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteFrameError';
  }
}

export class RemoteFrameTooLargeError extends Error {
  constructor() {
    super('Remote frame exceeds the maximum size');
    this.name = 'RemoteFrameTooLargeError';
  }
}
