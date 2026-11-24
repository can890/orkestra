import { join } from 'node:path';
import { isCustomAcpProviderId, pluginRegistry } from '@orkestra/plugins/agents';
import { app, net } from 'electron';
import {
  customAcpAgentsFilePath,
  CustomAcpAgentStore,
} from '@core/features/acp-registry/node/custom-agents-store';
import { AcpRegistryInstaller } from '@core/features/acp-registry/node/installer';
import { probeAcpAgent } from '@core/features/acp-registry/node/probe';
import { AcpRegistryClient } from '@core/features/acp-registry/node/registry-client';
import { AcpRegistryService } from '@core/features/acp-registry/node/service';
import { encryptedAppSecretsStore } from '@main/host/secrets/encrypted-app-secrets-store';
import { getUserShellEnv } from '@main/lib/userEnv';

// ACP Registry servisinin ana süreç bileşimi: Electron net.fetch (sistem proxy ayarlarına uyar),
// şifreli sır deposu, kullanıcı kabuk ortamı ve `<userData>/acp-registry` altındaki dosyalar.

export function createAcpRegistryOperations(): AcpRegistryService {
  const root = join(app.getPath('userData'), 'acp-registry');
  const fetch = (url: string, init?: RequestInit) => net.fetch(url, init);
  const env = async () => getUserShellEnv();
  return new AcpRegistryService({
    client: new AcpRegistryClient({ cacheDir: root, fetch }),
    installer: new AcpRegistryInstaller({ toolsDir: join(root, 'tools'), fetch, env }),
    store: new CustomAcpAgentStore(customAcpAgentsFilePath(app.getPath('userData')), () =>
      pluginRegistry.reload()
    ),
    secrets: encryptedAppSecretsStore,
    toolsDir: join(root, 'tools'),
    builtInProviderIds: () => pluginRegistry.ids().filter((id) => !isCustomAcpProviderId(id)),
    probe: (launch) => probeAcpAgent(launch),
    env,
  });
}
