// The single plugin registry
import type { CLIAgentPluginProvider } from '@orkestra/core/services/agent-plugins/api/plugins';
import { createPluginRegistry } from '@orkestra/shared/plugins';
import { createDynamicAgentRegistry } from './custom-acp/dynamic-registry';
import { CUSTOM_ACP_AGENTS_FILE_ENV } from './custom-acp/schema';
import { provider as antigravity } from './impl/antigravity';
import { provider as claude } from './impl/claude';
import { provider as codex } from './impl/codex';
import { provider as glm } from './impl/glm';
import { provider as grok } from './impl/grok';
import { provider as kimi } from './impl/kimi';

export { asAgentProviderId } from './types';
export type { AgentProviderId } from './types';
export * from './custom-acp/schema';
export {
  createCustomAcpProvider,
  customAcpAuthDescriptor,
  customAcpMcpConfigPath,
} from './custom-acp/provider';
export {
  createDynamicAgentRegistry,
  type DynamicAgentRegistry,
} from './custom-acp/dynamic-registry';
export {
  BUILT_IN_ACP_REGISTRY_AGENT_IDS,
  builtInProviderForRegistryAgent,
} from './custom-acp/builtin-registry-ids';
export { connectStdioAcp } from './helpers/acp-stdio';

const builtInRegistry = createPluginRegistry<CLIAgentPluginProvider>();

for (const p of [claude, codex, kimi, glm, antigravity, grok]) {
  builtInRegistry.register(p);
}

// İlk görülen yol sabitlenir; böylece ortamın sonradan yeniden yazılması kaydı boşaltmaz.
let customAgentsFile: string | undefined;

/** Yerleşik ajanlar + kullanıcının eklediği ACP ajanları (yalnızca yerel host süreçlerinde). */
export const pluginRegistry = createDynamicAgentRegistry({
  builtIns: builtInRegistry,
  filePath: () =>
    (customAgentsFile ??= process.env[CUSTOM_ACP_AGENTS_FILE_ENV]?.trim() || undefined),
});
