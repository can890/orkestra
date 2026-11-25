import type {
  CLIAgentPluginMetadata,
  CLIAgentPluginProvider,
} from '@orkestra/core/services/agent-plugins/api/plugins';
import { asAgentProviderId, pluginRegistry, type AgentProviderId } from '@orkestra/plugins/agents';

export function getPlugin(id: string): CLIAgentPluginProvider {
  const plugin = pluginRegistry.get(id);
  if (!plugin) throw new Error(`No plugin found for provider: ${id}`);
  return plugin;
}

export function getPluginMetadata(id: string): CLIAgentPluginMetadata {
  const plugin = pluginRegistry.get(id);
  if (!plugin) throw new Error(`No plugin metadata found for provider: ${id}`);
  return plugin.metadata;
}

export function listPlugins(): CLIAgentPluginProvider[] {
  return pluginRegistry.getAll();
}

/** Kayıtlı tüm ajan sağlayıcı kimlikleri (yerleşikler ve kullanıcının eklediği ACP ajanları). */
export function listProviderIds(): string[] {
  return pluginRegistry.ids();
}

export function isValidProviderId(value: unknown): value is AgentProviderId {
  return typeof value === 'string' && pluginRegistry.get(value) !== undefined;
}

export function toAgentProviderId(value: string): AgentProviderId {
  if (!isValidProviderId(value)) throw new Error(`Unknown agent provider: ${value}`);
  return asAgentProviderId(value);
}
