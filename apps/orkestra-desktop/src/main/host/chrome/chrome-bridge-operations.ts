import type { Scope } from '@orkestra/shared/concurrency';
import {
  ChromeBridgeService,
  type ChromeBridgeStoredSettings,
} from '@core/features/chrome/node/chrome-bridge-service';
import type { AgentToolsBridgeHost } from '@core/services/agent-tools/node/agent-tools-host';
import type { AppDb } from '@core/services/app-db/node/db';
import { AppDbKeyValueStore } from '@core/services/app-db/node/key-value-store';
import { encryptedAppSecretsStore } from '@main/host/secrets/encrypted-app-secrets-store';
import { isSecureStorageAvailable } from '@main/host/voice/voice-operations';
import { log } from '@main/lib/logger';

// Chrome köprüsünün ana süreç bileşimi: ayar kv tablosunda (migration gerekmez), belirteç şifreli
// sır deposunda. Köprü varsayılan kapalıdır; açılışta yalnızca kullanıcı açtıysa dinlemeye başlar.

type ChromeKvSchema = { settings: Partial<ChromeBridgeStoredSettings> };

export function createChromeBridgeService(deps: {
  db: AppDb;
  tools: AgentToolsBridgeHost;
  scope: Scope;
}): ChromeBridgeService {
  const kv = new AppDbKeyValueStore<ChromeKvSchema>(deps.db, 'chrome-bridge', log);
  const service = new ChromeBridgeService({
    tools: deps.tools,
    secrets: encryptedAppSecretsStore,
    settings: {
      get: () => kv.get('settings'),
      set: (settings) => kv.setOrThrow('settings', settings),
    },
    isSecureStorageAvailable,
    logger: log,
  });
  deps.scope.add(() => service.dispose());
  void service.start().catch((error) => {
    log.warn('Chrome köprüsü başlatılamadı', { error: String(error) });
  });
  return service;
}
