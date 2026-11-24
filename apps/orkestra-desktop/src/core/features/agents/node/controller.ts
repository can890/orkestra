import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  HostDependencyError,
  HostDependencySelection,
} from '@orkestra/core/primitives/host-dependencies/api';
import type {
  DependencyId,
  HostDependencyOperationProgress,
  HostDependencySnapshot,
} from '@orkestra/core/services/host-dependencies/node';
import { hostDependenciesContract } from '@orkestra/core/services/host-dependencies/node';
import type { HostDependenciesContract } from '@orkestra/core/services/host-dependencies/node';
import { runtimeResolveErrorAsError } from '@orkestra/core/services/runtime-broker/api';
import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import { err, ok, type Result } from '@orkestra/shared';
import type { ContractClient } from '@orkestra/wire/rpc';
import type { InstallMethod } from '@core/primitives/agents/api';
import {
  normalizeProviderOrchestratorConfig,
  type ProviderCustomConfig,
} from '@core/primitives/app-settings/api';
import { runRuntimeLiveJob } from '@core/services/runtime-clients/node/live-job';
import type { ProviderOverrideSettings } from '@core/services/settings/node/provider-settings-service';
import { toAgentUpdateError } from './agent-error-mapping';
import {
  buildAgentMetadataList,
  buildAgentPayload,
  buildAgentPayloads,
  customAgentInstallationStatuses,
  toAgentInstallationStatus,
} from './agent-payload-builder';

export type HostDependenciesClient = ContractClient<HostDependenciesContract>;
export type AgentOperationContext = {
  signal?: AbortSignal;
  progress?: (progress: HostDependencyOperationProgress) => void;
};

function getAntigravityOrchestratorConfigPath(): string {
  const dir =
    process.env.ORKESTRA_AGY_STATE_DIR ||
    join(homedir(), '.local', 'state', 'orkestra', 'antigravity');
  return join(dir, 'orchestrator-config.json');
}

async function syncAntigravityOrchestratorConfigFile(config: ProviderCustomConfig): Promise<void> {
  try {
    const normalized = normalizeProviderOrchestratorConfig(config.orchestrator);
    const target = getAntigravityOrchestratorConfigPath();
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomUUID()}.tmp`;
    const payload = {
      defaultMode: normalized?.defaultMode ?? null,
      planner: normalized?.plannerModel ?? null,
      executor: normalized?.executorModel ?? null,
      updatedAt: Date.now(),
    };
    await writeFile(temp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, target);
  } catch {
    // Best-effort runtime live-sync; persisted settings DB remains authoritative.
  }
}

export function createAgentOperations(dependencies: {
  ensureAgentDependenciesProbed(manager: HostDependenciesClient): Promise<void>;
  getDependencyManager(
    connectionId?: string
  ): Promise<Result<HostDependenciesClient, Parameters<typeof runtimeResolveErrorAsError>[0]>>;
  providerOverrideSettings: ProviderOverrideSettings;
}) {
  const { ensureAgentDependenciesProbed, getDependencyManager, providerOverrideSettings } =
    dependencies;
  return {
    // ── Metadata ────────────────────────────────────────────────────────────────

    list: async (connectionId?: string, manager?: HostDependenciesClient) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      const snapshot = await snapshotFor(mgr, ensureAgentDependenciesProbed);
      return buildAgentPayloads(providerOverrideSettings, snapshot, connectionId);
    },

    get: async (id: string, connectionId?: string, manager?: HostDependenciesClient) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      const snapshot = await snapshotFor(mgr, ensureAgentDependenciesProbed);
      return buildAgentPayload(providerOverrideSettings, id, snapshot, connectionId);
    },

    // ── Installation status ──────────────────────────────────────────────────────

    listAgentInstallationStatus: async (
      connectionId?: string,
      manager?: HostDependenciesClient
    ) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      const snapshot = await snapshotFor(mgr, ensureAgentDependenciesProbed);
      return [
        ...Object.values(snapshot.dependencies)
          .filter((view) => view.definition.category === 'agent')
          .map((view) => toAgentInstallationStatus(view.definition.id, connectionId, view)),
        ...(await customAgentInstallationStatuses(connectionId)),
      ];
    },

    getAgentInstallationStatus: async (
      id: string,
      connectionId?: string,
      manager?: HostDependenciesClient
    ) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      const snapshot = await snapshotFor(mgr, ensureAgentDependenciesProbed);
      if (!snapshot.dependencies[id]) {
        const custom = (await customAgentInstallationStatuses(connectionId)).find(
          (status) => status.id === id
        );
        if (custom) return custom;
      }
      return toAgentInstallationStatus(id, connectionId, snapshot.dependencies[id]);
    },

    // ── Install / update ─────────────────────────────────────────────────────────

    update: async (
      id: AgentProviderId,
      connectionId?: string,
      method?: InstallMethod,
      elevate?: boolean,
      manager?: HostDependenciesClient,
      context: AgentOperationContext = {}
    ) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      const result = method
        ? await runRuntimeLiveJob(
            hostDependenciesContract.runInstallCommand,
            mgr.runInstallCommand,
            { id, method, elevate, commandKind: 'update' },
            context.progress,
            { signal: context.signal }
          )
        : await runRuntimeLiveJob(
            hostDependenciesContract.runSelfUpdateCommand,
            mgr.runSelfUpdateCommand,
            { id },
            context.progress,
            { signal: context.signal }
          );
      if (result.success) {
        return {
          success: true as const,
          data: toAgentInstallationStatus(id, connectionId, result.data),
        };
      }
      return { success: false as const, error: toAgentUpdateError(result.error, id) };
    },

    install: async (
      id: AgentProviderId,
      connectionId?: string,
      method?: InstallMethod,
      elevate?: boolean,
      manager?: HostDependenciesClient,
      context: AgentOperationContext = {}
    ) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      const result = await runRuntimeLiveJob(
        hostDependenciesContract.runInstallCommand,
        mgr.runInstallCommand,
        { id, method, elevate },
        context.progress,
        { signal: context.signal }
      );
      if (result.success) {
        return {
          success: true as const,
          data: toAgentInstallationStatus(id, connectionId, result.data),
        };
      }
      return { success: false as const, error: result.error };
    },

    uninstall: async (id: AgentProviderId, _connectionId?: string, _method?: InstallMethod) => ({
      success: false as const,
      error: { type: 'no-uninstall-strategy' as const, id },
    }),

    // ── Settings ─────────────────────────────────────────────────────────────────

    getDefaultSettings: async (id: string): Promise<ProviderCustomConfig> => {
      const meta = await providerOverrideSettings.getItemWithMeta(id);
      return meta.defaults;
    },

    getSettings: async (id: string) => {
      return providerOverrideSettings.getItemWithMeta(id);
    },

    updateSettings: async (id: string, config: Partial<ProviderCustomConfig>): Promise<void> => {
      await providerOverrideSettings.updateItem(id, config);
      if (id === 'antigravity') {
        const meta = await providerOverrideSettings.getItemWithMeta('antigravity');
        await syncAntigravityOrchestratorConfigFile(meta.value);
      }
    },

    // ── Selection + probe ────────────────────────────────────────────────────────

    setUsedInstallation: async (
      id: DependencyId,
      connectionId: string | undefined,
      selection: HostDependencySelection,
      manager?: HostDependenciesClient
    ): Promise<Result<void, HostDependencyError>> => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      const result = await mgr.snapshot.mutate('setSelection', {
        key: undefined,
        input: { id, selection },
      });
      return result.success ? ok() : err(result.error);
    },

    probe: async (id: DependencyId, connectionId?: string, manager?: HostDependenciesClient) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      const result = await mgr.snapshot.mutate('refresh', {
        key: undefined,
        input: { id },
      });
      return result.success ? result.data.data.dependencies[id] : result;
    },

    resolveInstallation: async (
      id: DependencyId,
      selection: HostDependencySelection | undefined,
      connectionId?: string,
      manager?: HostDependenciesClient
    ) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      return mgr.resolver.resolve(selection === undefined ? { id } : { id, selection });
    },

    refreshLatestVersion: async (_id: DependencyId, _connectionId?: string): Promise<void> => {},

    probeAll: async (connectionId?: string, manager?: HostDependenciesClient) => {
      const mgr = await resolveDependencyManager(getDependencyManager, connectionId, manager);
      await ensureAgentDependenciesProbed(mgr);
    },

    listMetadata: async () => {
      return buildAgentMetadataList();
    },
  };
}

export type AgentOperations = ReturnType<typeof createAgentOperations>;

async function resolveDependencyManager(
  getDependencyManager: (
    connectionId?: string
  ) => ReturnType<Parameters<typeof createAgentOperations>[0]['getDependencyManager']>,
  connectionId?: string,
  manager?: HostDependenciesClient
): Promise<HostDependenciesClient> {
  if (manager) return manager;
  const result = await getDependencyManager(connectionId);
  if (!result.success) throw runtimeResolveErrorAsError(result.error);
  return result.data;
}

async function snapshotFor(
  manager: HostDependenciesClient,
  ensureProbed: (manager: HostDependenciesClient) => Promise<void>
): Promise<HostDependencySnapshot> {
  await ensureProbed(manager);
  const snapshot = await manager.snapshot.state(undefined, 'current').snapshot();
  return snapshot.data;
}
