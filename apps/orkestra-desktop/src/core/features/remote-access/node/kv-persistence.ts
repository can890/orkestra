import { z } from 'zod';
import type { AppDb } from '@core/services/app-db/node/db';
import { AppDbKeyValueStore } from '@core/services/app-db/node/key-value-store';
import type { RemoteAccessPersistence, StoredRemoteAccessState } from './remote-access-service';

// Mevcut `kv` tablosunda sürümlü JSON: yeni tablo/migration yok. Yalnızca sır olmayan
// meta veri (cihaz adları, zamanlar) tutulur; eşleştirme sırları şifreli sır deposundadır.

type RemoteAccessKvSchema = { state: StoredRemoteAccessState };

const storedStateSchema = z.object({
  version: z.literal(1),
  hostId: z.string().min(1),
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535).nullable(),
  // Sonradan eklendi: eski kayıtlarda yok, bu yüzden isteğe bağlı (sürüm artmaz, cihazlar korunur).
  accountPairing: z
    .object({
      enabled: z.boolean(),
      gistId: z.string().nullable(),
      publicKey: z.string().nullable(),
    })
    .optional()
    // Bozuk blok cihazları düşürmesin: yok sayılır, ayar kapalı başlar.
    .catch(undefined),
  devices: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      platform: z.string().nullable(),
      createdAt: z.number(),
      pairedAt: z.number().nullable(),
      expiresAt: z.number().nullable(),
      lastSeenAt: z.number().nullable(),
    })
  ),
});

/** Kayıtlı JSON'u doğrular; geçersizse `null`. Eski kayıtlar (`accountPairing` yok) geçerlidir. */
export function parseStoredRemoteAccessState(raw: unknown): StoredRemoteAccessState | null {
  const parsed = storedStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function createKvRemoteAccessPersistence(db: AppDb): RemoteAccessPersistence {
  // Günlükleyici bilerek verilmez: KV hata günlüğü değeri de yazar.
  const kv = new AppDbKeyValueStore<RemoteAccessKvSchema>(db, 'remote-access');
  return {
    async load() {
      const raw = await kv.get('state');
      if (raw === null) return null;
      // Bozuk kayıt: güvenli tarafta kal, sıfırdan başla (cihazlar yeniden eşleşir).
      return parseStoredRemoteAccessState(raw);
    },
    async save(state) {
      await kv.setOrThrow('state', state);
    },
  };
}
