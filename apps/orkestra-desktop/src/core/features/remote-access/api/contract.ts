import { defineContract, fallible, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

/**
 * Masaüstü kullanıcı arayüzünün "Mobil erişim" ayarları sözleşmesi. DİKKAT: bu domain yalnızca
 * yerel renderer içindir; uzak (mobil) oturumlara ASLA açılmaz (bkz. node/remote-surface.ts).
 * Hiçbir çıktı sır taşımaz, tek istisna `createPairing().payload`: QR içeriği eşleştirme sırrını
 * içerir ve yalnızca ekranda gösterilmek üzere bir kez döner.
 */

export const remoteAccessDomain = 'remoteAccess' as const;

export const remoteDeviceSchema = z.object({
  id: z.string(),
  /** İstemcinin bildirdiği ad; eşleşme tamamlanana dek boş değil, "Eşleşmeyi bekliyor". */
  name: z.string(),
  platform: z.string().nullable(),
  /** `pending`: QR üretildi ama telefon henüz eşleşmedi (süresi dolunca silinir). */
  status: z.enum(['pending', 'paired']),
  createdAt: z.number(),
  /** Yalnızca `pending` için: QR'ın geçerlilik sonu (epoch ms). */
  expiresAt: z.number().nullable(),
  pairedAt: z.number().nullable(),
  lastSeenAt: z.number().nullable(),
  /** Şu anda açık bir uzak oturumu var mı? */
  connected: z.boolean(),
});
export type RemoteDevice = z.infer<typeof remoteDeviceSchema>;

export const remoteAccessStateSchema = z.object({
  enabled: z.boolean(),
  /** Port gerçekten dinleniyor mu? (`enabled` iken bile başlatma başarısız olabilir.) */
  listening: z.boolean(),
  port: z.number().nullable(),
  /** QR'a girecek aday adresler (LAN, ardından Tailscale). */
  addresses: z.array(z.string()),
  hostName: z.string(),
  /** Sırların güvenle saklanabildiği (OS anahtarlığı) bir ortam mı? Değilse etkinleştirilemez. */
  secureStorageAvailable: z.boolean(),
  lastError: z.string().nullable(),
  devices: z.array(remoteDeviceSchema),
});
export type RemoteAccessState = z.infer<typeof remoteAccessStateSchema>;

export const remoteAccessErrorSchema = z.object({
  type: z.enum([
    'not-enabled',
    'storage-unavailable',
    'device-limit',
    'not-found',
    'listen-failed',
    'failed',
  ]),
  message: z.string(),
});
export type RemoteAccessError = z.infer<typeof remoteAccessErrorSchema>;

export const pairingResultSchema = z.object({
  deviceId: z.string(),
  expiresAt: z.number(),
  /** QR/elle giriş içeriği (JSON metni). Sır içerir; loglanmaz. */
  payload: z.string(),
});
export type PairingResult = z.infer<typeof pairingResultSchema>;

export const remoteAccessContract = defineContract({
  getState: procedure({ input: z.void(), output: remoteAccessStateSchema }),
  setEnabled: fallible({
    input: z.object({ enabled: z.boolean() }),
    data: remoteAccessStateSchema,
    error: remoteAccessErrorSchema,
  }),
  createPairing: fallible({
    input: z.void(),
    data: pairingResultSchema,
    error: remoteAccessErrorSchema,
  }),
  cancelPairing: fallible({
    input: z.object({ deviceId: z.string() }),
    error: remoteAccessErrorSchema,
  }),
  /** Cihazı siler; açık bağlantısı hemen kapanır. */
  revokeDevice: fallible({
    input: z.object({ deviceId: z.string() }),
    error: remoteAccessErrorSchema,
  }),
});

export type RemoteAccessContract = typeof remoteAccessContract;
