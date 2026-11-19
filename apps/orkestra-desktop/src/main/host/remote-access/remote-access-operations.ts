import { hostname, networkInterfaces } from 'node:os';
import { gitHubCredentialsSchema } from '@orkestra/plugins/integrations/github';
import { safeStorage } from 'electron';
import { getIntegrationAccountStore } from '@core/features/integrations/node/integration-account-store-instance';
import {
  AccountPairingCoordinator,
  type AccountPairingAccount,
} from '@core/features/remote-access/node/account-pairing-coordinator';
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

/** Varsayılan GitHub hesabı; belirteç yalnızca eşleşme belgesine yapılan çağrılarda kullanılır. */
async function readDefaultGitHubAccount(): Promise<AccountPairingAccount | null> {
  const record = await getIntegrationAccountStore().getAccount('github');
  if (!record) return null;
  const credentials = gitHubCredentialsSchema.safeParse(record.credentials);
  if (!credentials.success) return null;
  return {
    login: record.identity?.login ?? record.displayName ?? record.accountId,
    accountId: record.accountId,
    accessToken: credentials.data.accessToken,
    apiBaseUrl: credentials.data.apiBaseUrl,
  };
}

export function createRemoteAccessService(db: AppDb): RemoteAccessService {
  const logger = log.child({ component: 'remote-access' });
  const service = new RemoteAccessService({
    persistence: createKvRemoteAccessPersistence(db),
    secrets: encryptedAppSecretsStore,
    logger,
    hostName: () => hostname(),
    networkInterfaces: () => networkInterfaces(),
    isSecureStorageAvailable,
  });
  service.attachAccountPairing(
    new AccountPairingCoordinator({
      host: service.accountPairingHost(),
      secrets: encryptedAppSecretsStore,
      logger: logger.child({ component: 'account-pairing' }),
      getAccount: readDefaultGitHubAccount,
    })
  );
  return service;
}
