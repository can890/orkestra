import { z } from 'zod';

/**
 * Telefonun QR ile okuduğu eşleştirme yükü (UTF-8 JSON, boşluksuz). Şartname:
 * `agents/architecture/remote-access.md` → "QR yük şeması". Alan adları QR boyutunu küçük
 * tutmak için kısadır. `s` gizlidir: loglanmaz, hata mesajına girmez.
 */
export const PAIRING_PAYLOAD_KIND = 'orkestra-pair' as const;
export const PAIRING_PAYLOAD_VERSION = 1 as const;

export const pairingPayloadSchema = z.object({
  k: z.literal(PAIRING_PAYLOAD_KIND),
  /** Protokol sürümü (`REMOTE_PROTOCOL_VERSION`). */
  v: z.literal(PAIRING_PAYLOAD_VERSION),
  /** Masaüstü kimliği (UUID); telefon bağlantıları bununla ayırt eder. */
  h: z.string().min(1),
  /** Masaüstü görünen adı. */
  n: z.string().max(64),
  /** Aday adresler: önce LAN, sonra Tailscale. Telefon sırayla dener. */
  a: z.array(z.string().min(1)).max(6),
  /** WebSocket portu. */
  p: z.number().int().min(1).max(65535),
  /** Bu eşleştirmeye ayrılmış cihaz kimliği (el sıkışmadaki `deviceId`). */
  d: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  /** 32 baytlık eşleştirme sırrı, base64url (43 karakter). */
  s: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type PairingPayload = z.infer<typeof pairingPayloadSchema>;

export function serializePairingPayload(payload: PairingPayload): string {
  return JSON.stringify(payload);
}

/** Geçersiz ya da yanlış türde içerikte `null` döner. */
export function parsePairingPayload(text: string): PairingPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = pairingPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
