import { app } from 'electron';
import type { StoredOutsideAgentsState } from '@core/features/outside-agents/node/client-registry';
import { OutsideAgentsService } from '@core/features/outside-agents/node/outside-agents-service';
import type { AppDb } from '@core/services/app-db/node/db';
import { AppDbKeyValueStore } from '@core/services/app-db/node/key-value-store';
import { encryptedAppSecretsStore } from '@main/host/secrets/encrypted-app-secrets-store';
import { isSecureStorageAvailable } from '@main/host/voice/voice-operations';
import { log } from '@main/lib/logger';

// Dış ajan MCP sunucusunun ana süreç bileşimi: sır içermeyen durum kv tablosunda (migration
// gerekmez), belirteç özetleri şifreli sır deposunda. Varsayılan kapalıdır; gateway açılışında
// yalnızca kullanıcı açtıysa 127.0.0.1 üzerinde dinlemeye başlar.

type OutsideAgentsKvSchema = { state: StoredOutsideAgentsState };

export function createOutsideAgentsService(db: AppDb): OutsideAgentsService {
  const kv = new AppDbKeyValueStore<OutsideAgentsKvSchema>(db, 'outside-agents', log);
  return new OutsideAgentsService({
    persistence: {
      load: () => kv.get('state'),
      save: (state) => kv.setOrThrow('state', state),
    },
    secrets: encryptedAppSecretsStore,
    logger: log.child({ component: 'outside-agents' }),
    isSecureStorageAvailable,
    serverVersion: app.getVersion(),
  });
}
