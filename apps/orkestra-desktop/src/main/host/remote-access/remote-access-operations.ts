import fs from 'node:fs';
import net from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import path from 'node:path';
import { gitHubCredentialsSchema } from '@orkestra/plugins/integrations/github';
import { safeStorage } from 'electron';
import { getIntegrationAccountStore } from '@core/features/integrations/node/integration-account-store-instance';
import { encodeQr, qrToSvgPath } from '@core/features/remote-access/api/qr-code';
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
  if (process.platform === 'linux' && process.env.SOVRA_ALLOW_BASIC_STORAGE === '1') {
    safeStorage.setUsePlainTextEncryption?.(true);
    return safeStorage.isEncryptionAvailable();
  }
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== 'linux') return true;
  return safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
}

function resolveHostName(): string {
  const override = process.env.SOVRA_HOST_NAME?.trim();
  return override || hostname();
}

/**
 * Headless Linux sunucularda (örn. Xvfb üzerinde çalışan Huawei) tek seferlik QR eşleştirmesi
 * üretebilmek için yalnızca yerel kullanıcının (`0600`) erişebildiği UNIX soketi açar.
 * Sırlar loglanmaz; çıktı doğrudan SVG olarak soket istemcisine yazılır.
 */
function attachHeadlessPairingSocket(service: RemoteAccessService, socketPath: string): void {
  try {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  } catch {
    return;
  }

  const server = net.createServer((conn) => {
    void (async () => {
      try {
        const result = await service.createPairing();
        if (!result.success) {
          conn.end(`ERROR:${result.error.message}\n`);
          return;
        }
        const { d, viewSize } = qrToSvgPath(encodeQr(result.data.payload), 4);
        const svg =
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" width="420" height="420" shape-rendering="crispEdges">\n` +
          `<rect width="100%" height="100%" fill="#ffffff"/>\n` +
          `<path d="${d}" fill="#0b0f14"/>\n` +
          `</svg>\n`;
        conn.end(svg);
      } catch (err) {
        conn.end(`ERROR:${err instanceof Error ? err.message : String(err)}\n`);
      }
    })();
  });

  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      // en iyi çaba
    }
  });
  server.unref();
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
    hostName: resolveHostName,
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
  const pairSock = process.env.SOVRA_HEADLESS_PAIR_SOCK?.trim();
  if (pairSock) {
    attachHeadlessPairingSocket(service, pairSock);
  }
  return service;
}
