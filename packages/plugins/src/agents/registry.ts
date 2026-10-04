// The single plugin registry
import type { CLIAgentPluginProvider } from '@orkestra/core/services/agent-plugins/api/plugins';
import { createPluginRegistry } from '@orkestra/shared/plugins';
import { provider as antigravity } from './impl/antigravity';
import { provider as claude } from './impl/claude';
import { provider as codex } from './impl/codex';
import { provider as glm } from './impl/glm';
import { provider as grok } from './impl/grok';
import { provider as kimi } from './impl/kimi';

export { asAgentProviderId } from './types';
export type { AgentProviderId } from './types';

export const pluginRegistry = createPluginRegistry<CLIAgentPluginProvider>();

for (const p of [claude, codex, kimi, glm, antigravity, grok]) {
  pluginRegistry.register(p);
}
