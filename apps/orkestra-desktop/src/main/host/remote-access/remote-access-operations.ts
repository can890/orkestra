import { hostname, networkInterfaces } from 'node:os';
import { safeStorage } from 'electron';
import { createKvRemoteAccessPersistence } from '@core/features/remote-access/node/kv-persistence';
import { RemoteAccessService } from '@core/features/remote-access/node/remote-access-service';
import type { AppDb } from '@core/services/app-db/node/db';
import { encryptedAppSecretsStore } from '@main/host/secrets/encrypted-app-secrets-store';
import { log } from '@main/lib/logger';

// Mobil uzak erişim servisinin ana süreç bileşimi: KV'de sır olmayan durum, şifreli sır
// deposunda eşleştirme sırları, işletim sisteminden ağ arayüzleri ve ana makine adı.

function isSecureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== 'linux') return true;
  return safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
}

export function createRemoteAccessService(db: AppDb): RemoteAccessService {
  return new RemoteAccessService({
    persistence: createKvRemoteAccessPersistence(db),
    secrets: encryptedAppSecretsStore,
    logger: log.child({ component: 'remote-access' }),
    hostName: () => hostname(),
    networkInterfaces: () => networkInterfaces(),
    isSecureStorageAvailable,
  });
}
