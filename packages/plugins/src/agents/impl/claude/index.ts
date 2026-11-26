import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import {
  definePlugin,
  registerPluginBehavior,
} from '@orkestra/core/services/agent-plugins/api/plugins';
import type { AcpAgentApi } from '@orkestra/core/services/agent-plugins/api/plugins';
import {
  buildStandardCommand,
  homebrewOption,
  passthroughMcpAdapter,
} from '@orkestra/core/services/agent-plugins/api/plugins/helpers';
import { connectStdioAcp } from '../../helpers/acp-stdio';
import { resolveAdapterAsset } from '../../helpers/adapter-assets';
import { enrichClaudeUpdate } from './acp-transform';
import { claudeAdapter } from './adapter';
import { claudeAuthStatus } from './auth';
import { buildClaudeHookConfig } from './hooks';
import { icon } from './icon';
import { buildClaudeSessionMcp } from './session-mcp';
import { buildClaudeTrustBehavior } from './trust';

export const plugin = definePlugin(
  {
    id: 'claude',
    name: 'Claude Code',
    description:
      'CLI that uses Anthropic Claude for code edits, explanations, and structured refactors in the terminal.',
    websiteUrl: 'https://code.claude.com/docs/en/quickstart',
  },
  {
    acp: {
      kind: 'supported',
    },
    autoApprove: {
      kind: 'supported',
    },
    auth: {
      kind: 'supported',
      methods: [
        {
          kind: 'cli-login',
          id: 'claude-login',
          name: 'Sign in with Claude Code',
          args: ['auth', 'login'],
          description: 'Open the Claude Code CLI sign-in flow in a terminal.',
        },
        {
          kind: 'api-key',
          id: 'anthropic-api-key',
          name: 'Use an Anthropic API key',
          envVars: [{ name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key' }],
          helpUrl: 'https://docs.anthropic.com/en/api/admin-api/apikeys/get-api-key',
        },
      ],
    },
    models: {
      kind: 'selectable',
      modelOptions: {
        'claude-fable-5-2': {
          name: 'Claude Fable 5.2',
          description: 'En zor ve kritik görevler için Anthropic’in en güçlü Claude modeli.',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'claude-opus-5-6': {
          name: 'Claude Opus 5.6',
          description:
            'Karmaşık ve günlük kodlama işleri için yeni nesil amiral gemisi Claude modeli.',
          modelFeatures: { intelligence: 5, speed: 3 },
        },
        'claude-opus-5-5': {
          name: 'Claude Opus 5.5',
          description: 'Karmaşık ve günlük kodlama işleri için amiral gemisi Claude modeli.',
          modelFeatures: { intelligence: 5, speed: 3 },
        },
        'claude-sonnet-5-5': {
          name: 'Claude Sonnet 5.5',
          description: 'Günlük kodlama ve analiz için hızlı, güçlü Claude modeli.',
          modelFeatures: { intelligence: 4, speed: 4 },
        },
        'claude-haiku-5-5': {
          name: 'Claude Haiku 5.5',
          description: 'Hızlı yanıtlar ve basit görevler için en hızlı Claude modeli.',
          modelFeatures: { intelligence: 4, speed: 5 },
        },
        'claude-fable-5-1': {
          name: 'Claude Fable 5.1',
          description: 'Zor ve uzun soluklu görevler için önceki Fable modeli.',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'claude-haiku-4-5': {
          name: 'Claude Haiku 4.5',
          description: 'Hızlı ve ekonomik Claude modeli; basit ve mekanik işler için.',
          modelFeatures: { intelligence: 3, speed: 5 },
        },
        'claude-fable-5': {
          name: 'Claude Fable 5',
          modelFeatures: { intelligence: 4, speed: 3 },
        },
        'claude-opus-5': {
          name: 'Claude Opus 5',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'claude-sonnet-5': {
          name: 'Claude Sonnet 5',
          modelFeatures: { intelligence: 4, speed: 4 },
        },
        'claude-opus-4-8': {
          name: 'Claude Opus 4.8',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'claude-opus-4-7': {
          name: 'Claude Opus 4.7',
          modelFeatures: { intelligence: 4, speed: 2 },
        },
        'claude-opus-4-6': {
          name: 'Claude Opus 4.6',
          modelFeatures: { intelligence: 4, speed: 2 },
        },
        'claude-sonnet-4-6': {
          name: 'Claude Sonnet 4.6',
          modelFeatures: { intelligence: 4, speed: 4 },
        },
        'claude-mythos-5-2': {
          name: 'Claude Mythos 5.2',
          description: 'Özel erişimli Anthropic Mythos 5.2 modeli.',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'claude-mythos-5-1': {
          name: 'Claude Mythos 5.1',
          description: 'Önceki özel erişimli Anthropic Mythos 5.1 modeli.',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
      },
    },
    hooks: {
      kind: 'config',
      scope: 'global',
      supportedEvents: ['start', 'notification', 'stop', 'session'],
    },
    hostDependency: {
      id: 'claude',
      binaryNames: ['claude'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: 'curl -fsSL https://claude.ai/install.sh | bash',
            uninstallCommand: 'claude uninstall',
            recommended: true,
          },
          homebrewOption({ formula: 'claude-code', cask: true }),
        ],
        linux: [
          {
            method: 'curl',
            command: 'curl -fsSL https://claude.ai/install.sh | bash',
            uninstallCommand: 'claude uninstall',
          },
        ],
        windows: [
          {
            method: 'curl',
            command:
              'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd',
            uninstallCommand: 'claude uninstall',
          },
        ],
      },
      updateCommand: {
        kind: 'self',
        args: ['install', 'latest'],
      },
    },
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
    },
    prompt: {
      kind: 'argv',
      flag: '',
    },
    sessions: {
      kind: 'resumable',
    },
    trust: {
      kind: 'supported',
    },
  },
  { icon }
);

export const CLAUDE_EXPERIMENTAL_OPUS_5_6_ID = 'claude-opus-5-6';

export function buildClaudeSpawnEnv(
  cli: string,
  env?: Record<string, string | undefined>,
  hostEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const hasCustomModel = Boolean(
    env?.ANTHROPIC_CUSTOM_MODEL_OPTION?.trim() || hostEnv.ANTHROPIC_CUSTOM_MODEL_OPTION?.trim()
  );
  return {
    ELECTRON_RUN_AS_NODE: '1',
    // Point the adapter's Claude Agent SDK at the host-installed claude
    // binary instead of the SDK's auto-downloaded native binary.
    CLAUDE_CODE_EXECUTABLE: cli,
    ...(hasCustomModel
      ? {}
      : {
          ANTHROPIC_CUSTOM_MODEL_OPTION: CLAUDE_EXPERIMENTAL_OPUS_5_6_ID,
          ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'Opus 5.6',
          ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION:
            'Karmaşık ve günlük kodlama işleri için yeni nesil Opus modeli.',
        }),
  };
}

export function orderClaudeConfigOptions(
  options: SessionConfigOption[] | null | undefined
): SessionConfigOption[] | undefined {
  return options?.map((option) => {
    if (option.category !== 'model' || option.type !== 'select' || !Array.isArray(option.options)) {
      return option;
    }
    const items = option.options;
    const isFlat = items.every(
      (entry): entry is { value: string; name: string; description?: string | null } =>
        'value' in entry
    );
    if (!isFlat) return option;
    const opus56Index = items.findIndex((entry) => entry.value === CLAUDE_EXPERIMENTAL_OPUS_5_6_ID);
    if (opus56Index === -1) return option;
    const opus56 = items[opus56Index]!;
    const rest = items.filter((_, idx) => idx !== opus56Index);
    const opus55Index = rest.findIndex(
      (entry) =>
        entry.value === 'opus' ||
        entry.value.startsWith('opus[') ||
        entry.value === 'claude-opus-5-5'
    );
    const defaultIndex = rest.findIndex((entry) => entry.value === 'default');
    const insertAt =
      opus55Index !== -1 ? opus55Index : defaultIndex !== -1 ? defaultIndex + 1 : 0;
    return {
      ...option,
      options: [...rest.slice(0, insertAt), opus56, ...rest.slice(insertAt)],
    };
  });
}

export const provider = registerPluginBehavior(plugin, {
  acp: {
    buildSpawn: (ctx) => ({
      // Run the adapter as plain Node inside the Electron binary.
      command: process.execPath,
      args: [resolveAdapterAsset(claudeAdapter)],
      env: buildClaudeSpawnEnv(ctx.cli, ctx.env),
    }),
    connect(io, toClient) {
      const agent = connectStdioAcp(io, (raw) => {
        const client = toClient(raw);
        return new Proxy(client, {
          get(target, key) {
            if (key === 'sessionUpdate') {
              return (params: Parameters<typeof client.sessionUpdate>[0]) => {
                const update = params.update;
                return client.sessionUpdate({
                  ...params,
                  update:
                    update.sessionUpdate === 'config_option_update'
                      ? {
                          ...update,
                          configOptions: orderClaudeConfigOptions(update.configOptions) ?? [],
                        }
                      : update,
                });
              };
            }
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      });
      const map = <T extends { configOptions?: SessionConfigOption[] | null }>(result: T): T => ({
        ...result,
        ...(result.configOptions !== undefined
          ? { configOptions: orderClaudeConfigOptions(result.configOptions) }
          : {}),
      });
      const wrapped: AcpAgentApi = {
        initialize: (p) => agent.initialize(p),
        newSession: async (p) => map(await agent.newSession(p)),
        prompt: (p) => agent.prompt(p),
        cancel: (p) => agent.cancel(p),
      };
      if (agent.loadSession) wrapped.loadSession = async (p) => map(await agent.loadSession!(p));
      if (agent.setSessionConfigOption) {
        wrapped.setSessionConfigOption = async (p) => map(await agent.setSessionConfigOption!(p));
      }
      if (agent.setSessionMode) wrapped.setSessionMode = (p) => agent.setSessionMode!(p);
      return wrapped;
    },
    enrich: enrichClaudeUpdate,
  },
  auth: {
    checkStatus: claudeAuthStatus,
  },
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--dangerously-skip-permissions',
        initialPromptFlag: '',
        resumeFlag: '--resume',
        sessionIdFlag: '--session-id',
        modelFlag: '--model',
      }),
    buildSessionMcp: buildClaudeSessionMcp,
  },
  hooks: buildClaudeHookConfig(),
  mcp: passthroughMcpAdapter('.claude.json'),
  trust: buildClaudeTrustBehavior(),
});
