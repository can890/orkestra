const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function utf8Encode(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function utf8Decode(value: Uint8Array): string {
  return textDecoder.decode(value);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** RFC 4648 §5 base64url, dolgu (`=`) olmadan. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
    out += ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

/** Geçersiz girdide `null` döner (dolgu ve alfabe dışı karakterler reddedilir). */
export function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((value.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of value) {
    buffer = (buffer << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
      buffer &= (1 << bits) - 1;
    }
  }
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Sabit zamanlı eşitlik (uzunluk farkı hemen `false`). */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
