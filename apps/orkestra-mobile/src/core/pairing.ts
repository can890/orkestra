import {
  base64UrlDecode,
  isRemoteDeviceId,
  isValidRemoteAddress,
  REMOTE_SECRET_BYTES,
} from '@orkestra/wire/remote';

/**
 * QR / elle yapıştırılan eşleştirme yükü. Şema tek kaynağı:
 * `agents/architecture/remote-access.md` → "QR yük şeması". `s` (sır) gizlidir: bu dosyadaki
 * hiçbir hata mesajı ya da sonuç ayrıntısı sırrı içermez.
 */
export const PAIRING_KIND = 'orkestra-pair';
export const PAIRING_VERSION = 1;
const MAX_ADDRESSES = 6;
const MAX_QR_CHARS = 4096;

export type PairingPayload = {
  /** Masaüstü kimliği. */
  h: string;
  /** Masaüstü adı. */
  n: string;
  /** Aday adresler, denenme sırasıyla (LAN, Tailscale, `wss://` tünel). */
  a: string[];
  p: number;
  /** Cihaz kimliği. */
  d: string;
  /** 32 baytlık sır, base64url (43 karakter). */
  s: string;
  /** İsteğe bağlı salt-okunur dinamik tünel keşif URL'si (https://...). */
  u?: string;
};

export type PairingParseFailure =
  | 'empty'
  | 'too-large'
  | 'not-json'
  | 'not-orkestra'
  | 'unsupported-version'
  | 'invalid';

export type PairingParseResult =
  | { ok: true; payload: PairingPayload }
  | { ok: false; reason: PairingParseFailure };

/** URL'ye gömülecek adres: IPv4, IPv6, ana makine adı ya da `wss://` tünel URL'si. */
export function isValidAddress(value: unknown): value is string {
  return isValidRemoteAddress(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePairingPayload(input: string): PairingParseResult {
  const text = input.trim();
  if (text.length === 0) return { ok: false, reason: 'empty' };
  if (text.length > MAX_QR_CHARS) return { ok: false, reason: 'too-large' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (!isRecord(value) || value['k'] !== PAIRING_KIND) return { ok: false, reason: 'not-orkestra' };
  if (value['v'] !== PAIRING_VERSION) return { ok: false, reason: 'unsupported-version' };

  const { h, n, a, p, d, s, u } = value;
  if (typeof h !== 'string' || h.length === 0 || h.length > 128) return invalid();
  if (typeof n !== 'string' || n.length > 64) return invalid();
  if (!Array.isArray(a) || a.length === 0 || a.length > MAX_ADDRESSES) return invalid();
  if (!a.every(isValidAddress)) return invalid();
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) return invalid();
  if (typeof d !== 'string' || !isRemoteDeviceId(d)) return invalid();
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(s)) return invalid();
  if (base64UrlDecode(s)?.byteLength !== REMOTE_SECRET_BYTES) return invalid();
  const discoveryUrl =
    typeof u === 'string' && u.startsWith('https://') && u.length <= 512 ? u : undefined;

  return {
    ok: true,
    payload: {
      h,
      n,
      a: [...new Set(a as string[])],
      p,
      d,
      s,
      ...(discoveryUrl ? { u: discoveryUrl } : {}),
    },
  };
}

function invalid(): PairingParseResult {
  return { ok: false, reason: 'invalid' };
}

/** Kullanıcıya gösterilecek Türkçe açıklama (yük içeriğini ya da sırrı içermez). */
export function describePairingFailure(reason: PairingParseFailure): string {
  switch (reason) {
    case 'empty':
      return 'Eşleştirme kodu boş. Masaüstündeki kodu yapıştırın ya da QR okutun.';
    case 'too-large':
      return 'Bu metin bir Sovra eşleştirme kodu olamayacak kadar uzun.';
    case 'not-json':
      return 'Kod okunamadı. Masaüstündeki "Kodu kopyala" ile aldığınız metnin tamamını yapıştırın.';
    case 'not-orkestra':
      return 'Bu bir Sovra eşleştirme kodu değil.';
    case 'unsupported-version':
      return 'Bu kod daha yeni bir sürümden geliyor. Mobil uygulamayı güncelleyin.';
    case 'invalid':
      return 'Eşleştirme kodu eksik ya da bozuk. Masaüstünden yeni bir kod üretin.';
  }
}
