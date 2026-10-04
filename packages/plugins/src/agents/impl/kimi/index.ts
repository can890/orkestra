import {
  definePlugin,
  registerPluginBehavior,
} from '@orkestra/core/services/agent-plugins/api/plugins';
import type {
  AgentCommand,
  CommandContext,
} from '@orkestra/core/services/agent-plugins/api/plugins';
import {
  buildStandardCommand,
  passthroughMcpAdapter,
} from '@orkestra/core/services/agent-plugins/api/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { addKimiHooksToConfigText, buildKimiHookConfig } from './hooks';

function injectKimiHooksIntoInlineConfig(args: string[]): string[] {
  return args.map((arg, index) => {
    if (arg === '--config' && args[index + 1] !== undefined) return arg;
    if (index > 0 && args[index - 1] === '--config') return addKimiHooksToConfigText(arg);
    if (arg.startsWith('--config='))
      return `--config=${addKimiHooksToConfigText(arg.slice('--config='.length))}`;
    return arg;
  });
}

function buildKimiCommand(ctx: CommandContext): AgentCommand {
  const cmd = buildStandardCommand(ctx, {
    autoApproveFlag: '--yolo',
    resumeFlag: '-S',
    sessionIdFlag: '-S',
    sessionIdOnResumeOnly: true,
    resumeWithoutSessionFlag: '-c',
    omitAutoApproveOnResume: true,
    modelFlag: '--model',
  });
  return { ...cmd, args: injectKimiHooksIntoInlineConfig(cmd.args) };
}
import { join } from 'node:path';
import { parse as parseTOML } from 'smol-toml';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'kimi',
    name: 'Kimi',
    description: 'Moonshot AI Kimi Code ile sohbet ve terminal oturumları.',
    websiteUrl: 'https://code.kimi.com',
  },
  {
    acp: {
      kind: 'supported',
    },
    auth: {
      kind: 'supported',
      methods: [
        {
          kind: 'cli-login',
          id: 'kimi-login',
          name: 'Kimi hesabına giriş yap',
          args: ['login'],
          description: 'Kimi hesabınıza giriş yapar ve kullanılabilir modelleri yeniler.',
        },
      ],
    },
    models: {
      kind: 'selectable',
      modelOptions: {
        'kimi-code/kimi-for-coding': { name: 'K2.8 Önizleme' },
        'kimi-code/kimi-for-coding-highspeed': { name: 'K2.7 Code Hızlı' },
        'kimi-code/k3': { name: 'K3' },
        'kimi-code/k3-256k': { name: 'K3 (256 bin bağlam)' },
      },
    },
    mcp: { kind: 'supported', scope: 'global', supportedTransports: ['stdio', 'http'] },
    autoApprove: {
      kind: 'supported',
    },
    hooks: {
      kind: 'config',
      scope: 'global',
      supportedEvents: ['notification', 'stop', 'session', 'start'],
    },
    hostDependency: {
      id: 'kimi',
      binaryNames: ['kimi'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: 'curl -LsSf https://code.kimi.com/kimi-code/install.sh | bash',
          },
        ],
        linux: [
          {
            method: 'curl',
            command: 'curl -LsSf https://code.kimi.com/kimi-code/install.sh | bash',
          },
        ],
      },
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'none',
        },
        update: {
          kind: 'package-manager',
        },
      },
    },
    prompt: {
      kind: 'pty-only',
    },
    sessions: {
      kind: 'resumable',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  mcp: passthroughMcpAdapter('.kimi-code/mcp.json'),
  auth: {
    checkStatus: async (ctx) => {
      const home =
        ctx.env.KIMI_CODE_HOME || (ctx.env.HOME ? join(ctx.env.HOME, '.kimi-code') : undefined);
      if (!home) return { kind: 'unknown' };
      const content = await ctx.fs.read(join(home, 'config.toml'));
      if (!content) return { kind: 'unauthenticated', message: 'Kimi hesabınıza giriş yapın.' };
      try {
        const config = parseTOML(content);
        if (!config.models || Object.keys(config.models).length === 0)
          return {
            kind: 'unauthenticated',
            message: 'Kimi model listesi boş. Yeniden giriş yaparak modelleri yenileyin.',
          };
        return { kind: 'unknown' };
      } catch {
        return { kind: 'unknown', message: 'Kimi yapılandırması okunamadı.' };
      }
    },
  },
  acp: {
    ...createNativeAcpBehavior(() => ({ args: ['acp'] })),
    connect(io, toClient) {
      const agent = createNativeAcpBehavior(() => ({ args: ['acp'] })).connect(io, toClient);
      const original = agent.newSession.bind(agent);
      agent.newSession = async (params) => {
        const result = await original(params);
        const model = result.configOptions?.find((option) => option.category === 'model');
        if (model?.type === 'select' && model.options.length === 0)
          throw new Error(
            'Kimi model listesi boş. Sohbet başlangıcındaki Kimi hesabına giriş yap adımını tamamlayın veya terminalde kimi login komutunu çalıştırın.'
          );
        return result;
      };
      return agent;
    },
  },
  prompt: {
    buildCommand: buildKimiCommand,
  },
  hooks: buildKimiHookConfig(),
  sessions: {
    validateSessionId: undefined,
  },
});
