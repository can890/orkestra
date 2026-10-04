import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import {
  definePlugin,
  registerPluginBehavior,
} from '@orkestra/core/services/agent-plugins/api/plugins';
import type {
  AcpAgentApi,
  AcpSpawnContext,
} from '@orkestra/core/services/agent-plugins/api/plugins';
import { passthroughMcpAdapter } from '@orkestra/core/services/agent-plugins/api/plugins/helpers';
import { connectStdioAcp } from '../../helpers/acp-stdio';
import { resolveAdapterAsset } from '../../helpers/adapter-assets';
import { claudeAdapter } from '../claude/adapter';

const models = {
  'glm-5.3': { name: 'GLM 5.3', description: 'Z.ai üzerinde gelişmiş kodlama ve analiz modeli.' },
  'glm-5.3-flash': { name: 'GLM 5.3 Flash', description: 'Z.ai üzerinde hızlı kodlama modeli.' },
};
const visibleModel = (id: string) =>
  id === 'haiku' || id === 'glm-5.3-flash' ? 'glm-5.3-flash' : 'glm-5.3';
export function localizeGlmOptions(options: SessionConfigOption[] | null | undefined) {
  return options?.map((option) =>
    option.category === 'model' && option.type === 'select'
      ? {
          ...option,
          currentValue: visibleModel(option.currentValue),
          options: Object.entries(models).map(([value, model]) => ({ value, ...model })),
        }
      : option
  );
}
export function buildGlmSpawn(ctx: AcpSpawnContext) {
  if (!ctx.env.ZAI_API_KEY?.trim())
    throw new Error(
      'GLM için sohbet başlangıcında Z.ai API anahtarınızı ekleyin veya Ajanlar > GLM / Z.ai > Gelişmiş ayarlar bölümünde ZAI_API_KEY tanımlayın.'
    );
  return {
    command: process.execPath,
    args: [resolveAdapterAsset(claudeAdapter)],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      CLAUDE_CODE_EXECUTABLE: ctx.cli,
      CLAUDE_CONFIG_DIR: join(ctx.env.HOME || homedir(), '.orkestra', 'glm-claude'),
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: ctx.env.ZAI_API_KEY,
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
      ANTHROPIC_MODEL: 'glm-5.3',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  };
}
export const plugin = definePlugin(
  {
    id: 'glm',
    name: 'GLM / Z.ai',
    description:
      'Z.ai GLM modelleriyle sohbet. Z.ai Coding Plan API anahtarı gerekir; Claude hesabınızı değiştirmez.',
    websiteUrl: 'https://docs.z.ai/devpack/tool/claude',
  },
  {
    acp: { kind: 'supported' },
    autoApprove: { kind: 'supported' },
    mcp: { kind: 'supported', scope: 'global', supportedTransports: ['stdio', 'http'] },
    auth: {
      kind: 'supported',
      methods: [
        {
          kind: 'api-key',
          id: 'zai-api-key',
          name: 'Z.ai API anahtarı',
          envVars: [{ name: 'ZAI_API_KEY', label: 'Z.ai API anahtarı' }],
          helpUrl: 'https://z.ai/manage-apikey/apikey-list',
        },
      ],
    },
    models: { kind: 'selectable', modelOptions: models },
    hostDependency: {
      id: 'glm',
      binaryNames: ['claude'],
      installCommands: {
        macos: [{ method: 'curl', command: 'curl -fsSL https://claude.ai/install.sh | bash' }],
        linux: [{ method: 'curl', command: 'curl -fsSL https://claude.ai/install.sh | bash' }],
      },
    },
    prompt: { kind: 'none' },
    sessions: { kind: 'resumable' },
  },
  {
    icon: {
      kind: 'svg',
      alt: 'GLM / Z.ai',
      variants: [
        {
          minSize: 0,
          light:
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 5h16v3L9 16h11v3H4v-3l11-8H4z" fill="currentColor"/></svg>',
        },
      ],
    },
  }
);
export const provider = registerPluginBehavior(plugin, {
  mcp: passthroughMcpAdapter('.orkestra/glm-claude/.claude.json'),
  auth: {
    checkStatus: async (ctx) =>
      ctx.env.ZAI_API_KEY?.trim()
        ? { kind: 'authenticated' }
        : { kind: 'unauthenticated', message: 'Z.ai API anahtarınızı ekleyin.' },
  },
  acp: {
    buildSpawn: buildGlmSpawn,
    connect(io, toClient) {
      const agent = connectStdioAcp(io, (raw) => {
        const client = toClient(raw);
        return new Proxy(client, {
          get(target, key) {
            if (key === 'sessionUpdate')
              return (params: Parameters<typeof client.sessionUpdate>[0]) => {
                const update = params.update;
                return client.sessionUpdate({
                  ...params,
                  update:
                    update.sessionUpdate === 'config_option_update'
                      ? { ...update, configOptions: localizeGlmOptions(update.configOptions) ?? [] }
                      : update,
                });
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      });
      const map = <T extends { configOptions?: SessionConfigOption[] | null }>(result: T): T => ({
        ...result,
        configOptions: localizeGlmOptions(result.configOptions),
      });
      const wrapped: AcpAgentApi = {
        initialize: (p) => agent.initialize(p),
        newSession: async (p) => map(await agent.newSession(p)),
        prompt: (p) => agent.prompt(p),
        cancel: (p) => agent.cancel(p),
      };
      if (agent.loadSession) wrapped.loadSession = async (p) => map(await agent.loadSession!(p));
      if (agent.setSessionConfigOption)
        wrapped.setSessionConfigOption = async (p) =>
          map(
            await agent.setSessionConfigOption!(
              typeof p.value === 'string' && p.configId === 'model'
                ? {
                    ...p,
                    value:
                      p.value === 'glm-5.3-flash'
                        ? 'haiku'
                        : p.value === 'glm-5.3'
                          ? 'sonnet'
                          : p.value,
                  }
                : p
            )
          );
      if (agent.setSessionMode) wrapped.setSessionMode = (p) => agent.setSessionMode!(p);
      return wrapped;
    },
  },
});
