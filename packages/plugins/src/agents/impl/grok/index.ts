import {
  definePlugin,
  registerPluginBehavior,
} from '@orkestra/core/services/agent-plugins/api/plugins';
import {
  buildStandardCommand,
  grokMcpAdapter,
} from '@orkestra/core/services/agent-plugins/api/plugins/helpers';
import { grokAcpBehavior } from './acp';
import { buildGrokHookConfig } from './hooks';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'grok',
    name: 'Grok',
    description:
      "xAI's Grok CLI for terminal-first coding sessions with plans, subagents, and parallel work.",
    websiteUrl: 'https://docs.x.ai/build/overview',
  },
  {
    acp: {
      kind: 'supported',
    },
    models: {
      kind: 'selectable',
      modelOptions: {
        'grok-4.7': { name: 'Grok 4.7' },
        'grok-4.7-build-fast': { name: 'Grok 4.7 Fast' },
        'grok-4.6': { name: 'Grok 4.6' },
        'grok-4.5': { name: 'Grok 4.5' },
      },
    },
    autoApprove: {
      kind: 'supported',
    },
    hooks: {
      kind: 'config',
      scope: 'global',
      supportedEvents: ['notification', 'stop', 'session', 'start'],
    },
    hostDependency: {
      id: 'grok',
      binaryNames: ['grok'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
            updateCommand: 'grok update',
            recommended: true,
          },
          {
            method: 'npm',
            command: 'npm install -g @xai-official/grok@latest',
            updateCommand: 'npm install -g @xai-official/grok@latest',
            uninstallCommand: 'npm uninstall -g @xai-official/grok',
            elevation: 'on-failure',
          },
        ],
        linux: [
          {
            method: 'curl',
            command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
            updateCommand: 'grok update',
            recommended: true,
          },
          {
            method: 'npm',
            command: 'npm install -g @xai-official/grok@latest',
            updateCommand: 'npm install -g @xai-official/grok@latest',
            uninstallCommand: 'npm uninstall -g @xai-official/grok',
            elevation: 'on-failure',
          },
        ],
        windows: [
          {
            method: 'powershell',
            command:
              'powershell -ExecutionPolicy ByPass -c "irm https://x.ai/cli/install.ps1 | iex"',
            updateCommand: 'grok update',
            recommended: true,
          },
          {
            method: 'npm',
            command: 'npm install -g @xai-official/grok@latest',
            updateCommand: 'npm install -g @xai-official/grok@latest',
            uninstallCommand: 'npm uninstall -g @xai-official/grok',
            elevation: 'on-failure',
          },
        ],
      },
      installDocs: 'https://docs.x.ai/build/overview',
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'npm',
          package: '@xai-official/grok',
        },
        update: {
          kind: 'package-manager',
        },
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
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  acp: grokAcpBehavior,
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--always-approve',
        initialPromptFlag: '',
        resumeFlag: '-r',
        sessionIdFlag: '-r',
        sessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '-r',
        modelFlag: '-m',
      }),
  },
  hooks: buildGrokHookConfig(),
  mcp: grokMcpAdapter(),
});
