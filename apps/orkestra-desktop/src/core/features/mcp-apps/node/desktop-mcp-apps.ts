import { join } from 'node:path';
import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import type { McpServer } from '@orkestra/core/primitives/mcp/api';
import { mcpServerNameMatches } from '@orkestra/core/runtimes/acp/api/client';
import type { RuntimeBroker } from '@orkestra/core/services/runtime-broker/api';
import type { Scope } from '@orkestra/shared/concurrency';
import type { Logger } from '@orkestra/shared/logger';
import type { AppSettingsService } from '@core/services/settings/node';
import { McpAppsService } from './mcp-apps-service';
import { McpAppSnapshotStore } from './snapshot-store';

/** "mcpApps" ayarına göre bir sunucunun uygulamaları gösterilebilir mi. */
export function mcpAppsEnabledFor(
  settings: { enabled: boolean; disabledServers: readonly string[] },
  server: string
): boolean {
  return (
    settings.enabled && !settings.disabledServers.some((name) => mcpServerNameMatches(name, server))
  );
}

/**
 * Masaüstü kompozisyonu: anlık görüntüler `userData/mcp-apps` altında, sunucu tanımları yerel
 * makinenin ajan yapılandırmasından (`agentConfig.listMcpForAgent`). Bağlantılar uygulama
 * kapanırken kapatılır.
 */
export function createDesktopMcpAppsService(deps: {
  appSettings: AppSettingsService;
  runtimes: RuntimeBroker;
  logger: Logger;
  scope: Scope;
  userDataDirectory: string;
  version: string;
}): McpAppsService {
  const service = new McpAppsService({
    store: new McpAppSnapshotStore(join(deps.userDataDirectory, 'mcp-apps')),
    isEnabled: async (server) => mcpAppsEnabledFor(await deps.appSettings.get('mcpApps'), server),
    listServers: async (providerId): Promise<McpServer[]> => {
      const runtime = await deps.runtimes.client(LOCAL_HOST_REF);
      if (!runtime.success) throw new Error('The local host runtime is unavailable.');
      const listed = await runtime.data.agentConfig.listMcpForAgent({ providerId });
      if (!listed.success) {
        const error = listed.error;
        throw new Error('message' in error ? error.message : `Unknown agent: ${providerId}`);
      }
      return listed.data.servers;
    },
    clientInfo: { name: 'orkestra', version: deps.version },
    logger: deps.logger,
  });
  deps.scope.add(() => service.dispose());
  return service;
}
