import type {
  AgentAuthDescriptor,
  CLIAgentPluginProvider,
} from '@orkestra/core/services/agent-plugins/api/plugins';
import type {
  HostDependencySnapshot,
  HostDependencyView,
} from '@orkestra/core/services/host-dependencies/node';
import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import { findExecutable } from '@core/features/acp-registry/api/node/find-executable';
import { getPlugin, listPlugins } from '@core/features/agents/api/node/plugin-registry';
import type {
  AgentInstallationStatus,
  AgentMetadata,
  AgentPayload,
  Installation,
  SelectedSource,
} from '@core/primitives/agents/api';
import type { ProviderOverrideSettings } from '@core/services/settings/node/provider-settings-service';

function buildMetadata(provider: CLIAgentPluginProvider): AgentMetadata {
  const { metadata, capabilities, assets } = provider;
  return {
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    websiteUrl: metadata.websiteUrl,
    icon: assets.icon,
    capabilities: {
      acp: capabilities.acp,
      auth: buildAuthDescriptor(provider),
      hostDependency: {
        updates: capabilities.hostDependency.updateCommand
          ? {
              kind: 'supported' as const,
              update: {
                kind: 'cli' as const,
                args: capabilities.hostDependency.updateCommand.args,
              },
            }
          : { kind: 'none' as const },
        uninstall: { kind: 'none' as const },
      },
      models: capabilities.models,
      effort: capabilities.effort,
      prompt: capabilities.prompt,
      sessions: capabilities.sessions,
      autoApprove: capabilities.autoApprove,
      hooks: capabilities.hooks,
      mcp: capabilities.mcp,
      plugins: capabilities.plugins,
      trust: capabilities.trust,
    },
    installDocs: capabilities.hostDependency.installDocs ?? null,
  };
}

function buildAuthDescriptor(provider: CLIAgentPluginProvider): AgentAuthDescriptor {
  const auth = provider.capabilities.auth as AgentAuthDescriptor | undefined;
  if (auth?.kind === 'supported') return auth;
  // Kullanıcı ACP ajanları yalnızca kendi bildirdikleri giriş yöntemlerini sunar; ACP sunucusunu
  // terminalde argümansız açmak bir giriş akışı değildir.
  if (isCustomAgent(provider)) return { kind: 'none' };

  const binaryName = provider.capabilities.hostDependency.binaryNames[0] ?? provider.metadata.id;
  return {
    kind: 'supported',
    methods: [
      {
        kind: 'cli-login',
        id: 'cli-login',
        name: `Sign in with ${provider.metadata.name}`,
        args: [],
        description: `Open ${binaryName} in a terminal and complete the provider sign-in flow.`,
      },
    ],
  };
}

async function buildOne(
  providerSettings: ProviderOverrideSettings,
  id: AgentProviderId,
  snapshot?: HostDependencySnapshot,
  connectionId?: string
): Promise<AgentPayload | null> {
  const provider = getPlugin(id);
  if (!provider) return null;

  const settingsMeta = await providerSettings.getItemWithMeta(id);
  if (isCustomAgent(provider)) {
    // Kullanıcı ACP ajanları yalnızca yerel hostta çalışır; uzak hostlarda listelenmez.
    if (connectionId) return null;
    return {
      ...buildMetadata(provider),
      ...(await customAgentInstallationStatus(provider, connectionId)),
      settings: settingsMeta,
    };
  }
  const view = snapshot?.dependencies[id];
  const used: SelectedSource = view?.selection ?? { kind: 'auto' };

  return {
    ...buildMetadata(provider),
    connectionId,
    status: view?.status ?? 'missing',
    version: null,
    latestVersion: null,
    updateAvailable: false,
    command: view?.resolved?.path ?? null,
    settings: settingsMeta,
    installOptions: view?.installOptions ?? [],
    installations: view ? installationsFromView(view) : [],
    used,
    usedId: sourceKey(used),
  };
}

export async function buildAgentPayload(
  providerSettings: ProviderOverrideSettings,
  id: string,
  snapshot?: HostDependencySnapshot,
  connectionId?: string
): Promise<AgentPayload | null> {
  return buildOne(providerSettings, id as AgentProviderId, snapshot, connectionId);
}

export async function buildAgentPayloads(
  providerSettings: ProviderOverrideSettings,
  snapshot?: HostDependencySnapshot,
  connectionId?: string
): Promise<AgentPayload[]> {
  const results = await Promise.all(
    listPlugins().map((provider) =>
      buildOne(providerSettings, provider.metadata.id as AgentProviderId, snapshot, connectionId)
    )
  );
  return results.filter((r): r is AgentPayload => r !== null);
}

export function buildAgentMetadataList(): AgentMetadata[] {
  return listPlugins().map(buildMetadata);
}

function isCustomAgent(provider: CLIAgentPluginProvider): boolean {
  return provider.behavior.hostDependency?.resolveExecutable !== undefined;
}

/** Kullanıcı ACP ajanının kurulum durumu: sabit çalıştırılabilir dosya mevcut mu? */
export async function customAgentInstallationStatus(
  provider: CLIAgentPluginProvider,
  connectionId: string | undefined
): Promise<AgentInstallationStatus> {
  const command = provider.behavior.hostDependency?.resolveExecutable?.() ?? '';
  const path = command ? await findExecutable(command) : undefined;
  const used: SelectedSource = { kind: 'auto' };
  return {
    id: provider.metadata.id,
    connectionId,
    status: path ? 'available' : 'missing',
    version: null,
    latestVersion: null,
    updateAvailable: false,
    command: path ?? (command || null),
    installations: [],
    used,
    usedId: sourceKey(used),
    installOptions: [],
  };
}

/** Yerel hosttaki kullanıcı ACP ajanlarının durumları. */
export async function customAgentInstallationStatuses(
  connectionId: string | undefined
): Promise<AgentInstallationStatus[]> {
  if (connectionId) return [];
  return Promise.all(
    listPlugins()
      .filter(isCustomAgent)
      .map((provider) => customAgentInstallationStatus(provider, connectionId))
  );
}

export function toAgentInstallationStatus(
  id: string,
  connectionId: string | undefined,
  view: HostDependencyView | undefined
): AgentInstallationStatus {
  const used: SelectedSource = view?.selection ?? { kind: 'auto' };
  return {
    id,
    connectionId,
    status: view?.status ?? 'missing',
    version: null,
    latestVersion: null,
    updateAvailable: false,
    command: view?.resolved?.path ?? null,
    installations: view ? installationsFromView(view) : [],
    used,
    usedId: sourceKey(used),
    installOptions: view?.installOptions ?? [],
  };
}

function installationsFromView(view: HostDependencyView): Installation[] {
  const installations: Installation[] = view.candidates.map((candidate) => ({
    id: candidate.realpath,
    realpath: candidate.realpath,
    pathEntry: candidate.path,
    isActive: !view.selection && candidate.isPathDefault,
    manageable: false,
    provenance: { kind: 'unknown', confidence: 'inferred' },
    status: 'available',
    version: null,
    latestVersion: null,
    updateAvailable: false,
  }));
  if (view.selection) {
    const value = view.selection.kind === 'path' ? view.selection.path : view.selection.command;
    installations.push({
      id: view.selection.kind,
      realpath: view.resolved?.realpath ?? value,
      pathEntry: value,
      isActive: true,
      manageable: false,
      provenance: { kind: 'manual', confidence: 'confirmed' },
      status: view.status,
      version: null,
      latestVersion: null,
      updateAvailable: false,
    });
  }
  return installations;
}

function sourceKey(source: SelectedSource): string {
  if (source.kind === 'auto') return 'auto';
  if (source.kind === 'pinned') return source.realpath;
  if (source.kind === 'method') return `method:${source.method}`;
  return source.kind;
}
