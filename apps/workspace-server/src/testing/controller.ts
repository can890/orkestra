import { acpApiContract } from '@orkestra/core/runtimes/acp/api';
import { agentConfigContract } from '@orkestra/core/runtimes/agent-config/api';
import { automationsContract } from '@orkestra/core/runtimes/automations/api';
import { conversationsContract } from '@orkestra/core/runtimes/conversations/api';
import { fileSearchContract } from '@orkestra/core/runtimes/file-search/api';
import { filesContract } from '@orkestra/core/runtimes/files/api';
import { gitContract } from '@orkestra/core/runtimes/git/api';
import { hostSettingsContract } from '@orkestra/core/runtimes/host-settings/api';
import { resourceUsageContract } from '@orkestra/core/runtimes/resource-usage/api';
import { scriptsContract } from '@orkestra/core/runtimes/scripts/api';
import { terminalsContract } from '@orkestra/core/runtimes/terminals/api';
import { tuiAgentsContract } from '@orkestra/core/runtimes/tui-agents/api';
import { workspaceRegistryContract } from '@orkestra/core/runtimes/workspace-registry/api';
import { hostDependenciesContract } from '@orkestra/core/services/host-dependencies/api';
import { client } from '@orkestra/wire/rpc';
import type { Connection, Contract, ContractClient, ContractDefinitions } from '@orkestra/wire/rpc';
import { createWorkspaceWireController, type WorkspaceWireControllerDeps } from '../api/controller';
import type { WorkspaceServerRuntimeClients } from '../gateway/workspace-workers';

type ControllerMetadata = Partial<
  Pick<WorkspaceWireControllerDeps, 'appVersion' | 'daemonId' | 'startedAt'>
>;

export function createTestWorkspaceWireController(
  runtimes: Partial<WorkspaceServerRuntimeClients> = {},
  metadata: ControllerMetadata = {}
) {
  return createWorkspaceWireController({
    ...metadata,
    runtimes: createTestRuntimeClients(runtimes),
    hostDependencies: createDisconnectedClient(hostDependenciesContract),
  });
}

export function createTestRuntimeClients(
  overrides: Partial<WorkspaceServerRuntimeClients> = {}
): WorkspaceServerRuntimeClients {
  return {
    acp: createDisconnectedClient(acpApiContract),
    agentConfig: createDisconnectedClient(agentConfigContract),
    automations: createDisconnectedClient(automationsContract),
    conversations: createDisconnectedClient(conversationsContract),
    fileSearch: createDisconnectedClient(fileSearchContract),
    files: createDisconnectedClient(filesContract),
    git: createDisconnectedClient(gitContract),
    hostSettings: createDisconnectedClient(hostSettingsContract),
    resourceUsage: createDisconnectedClient(resourceUsageContract),
    scripts: createDisconnectedClient(scriptsContract),
    terminals: createDisconnectedClient(terminalsContract),
    tuiAgents: createDisconnectedClient(tuiAgentsContract),
    workspaceRegistry: createDisconnectedClient(workspaceRegistryContract),
    ...overrides,
  };
}

function createDisconnectedClient<Defs extends ContractDefinitions>(
  contract: Contract<Defs>
): ContractClient<Defs> {
  return client(contract, disconnectedConnection);
}

const disconnectedConnection: Connection = {
  call: async () => {
    throw new Error('Test runtime client is not connected');
  },
  openBlobConsumer: () => {
    throw new Error('Test runtime client is not connected');
  },
  openBlobProducer: () => {
    throw new Error('Test runtime client is not connected');
  },
  snapshot: async () => {
    throw new Error('Test runtime client is not connected');
  },
  attach: async () => {
    throw new Error('Test runtime client is not connected');
  },
  onDisconnect: () => () => {},
  dispose: () => {},
};
