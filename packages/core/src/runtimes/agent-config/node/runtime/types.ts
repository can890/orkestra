import type { Scope } from '@orkestra/shared/concurrency';
import type { Logger } from '@orkestra/shared/logger';
import type { AgentPluginHost } from '#services/agent-plugins/api/plugins';
import type { SpawnContext } from '#services/agent-plugins/api/spawn-context';
import type { PtySpawner } from '#services/pty/api';

export type AgentConfigSpawnContext = SpawnContext;

export interface AgentConfigRuntimeDeps {
  scope: Scope;
  agentHost: AgentPluginHost;
  ptySpawner: PtySpawner;
  logger: Logger;
  platform?: NodeJS.Platform;
}
