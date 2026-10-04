import {
  definePlugin,
  registerPluginBehavior,
} from '@emdash/core/services/agent-plugins/api/plugins';
import { buildStandardCommand, passthroughMcpAdapter } from '@emdash/core/services/agent-plugins/api/plugins/helpers';
import { connectStdioAcp } from '../../helpers/acp-stdio';
import { resolveAdapterAsset } from '../../helpers/adapter-assets';
import { antigravityAdapter } from './adapter';
import { buildAntigravityHookConfig } from './hooks';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'antigravity',
    name: 'Antigravity',
    description:
      'Ortak Antigravity ayarları ve sohbet geçmişiyle terminal ve sohbet oturumları.',
    websiteUrl: 'https://antigravity.google/docs/cli-overview',
  },
  {
    acp: { kind: 'supported' },
    mcp: { kind: 'supported', scope: 'global', supportedTransports: ['stdio', 'http'] },
    autoApprove: {
      kind: 'supported',
    },
    hooks: {
      kind: 'config',
      scope: 'global',
      supportedEvents: ['session', 'start', 'stop'],
    },
    models: {
      kind: 'selectable',
      modelOptions: {
        'gemini-3.8-flash-high': {
          name: 'Gemini 3.8 Flash (Yüksek)',
          modelFeatures: { intelligence: 4, speed: 4 },
        },
        'gemini-3.8-flash-medium': {
          name: 'Gemini 3.8 Flash (Orta)',
          modelFeatures: { intelligence: 3, speed: 5 },
        },
        'gemini-3.8-flash-low': {
          name: 'Gemini 3.8 Flash (Düşük)',
          modelFeatures: { intelligence: 2, speed: 5 },
        },
        'gemini-3.7-flash-high': {
          name: 'Gemini 3.7 Flash (Yüksek)',
          modelFeatures: { intelligence: 4, speed: 4 },
        },
        'gemini-3.7-flash-medium': {
          name: 'Gemini 3.7 Flash (Orta)',
          modelFeatures: { intelligence: 3, speed: 5 },
        },
        'gemini-3.7-flash-low': {
          name: 'Gemini 3.7 Flash (Düşük)',
          modelFeatures: { intelligence: 2, speed: 5 },
        },
        'gemini-3.6-flash-high': {
          name: 'Gemini 3.6 Flash (Yüksek)',
          modelFeatures: { intelligence: 4, speed: 3 },
        },
        'gemini-3.6-flash-medium': {
          name: 'Gemini 3.6 Flash (Orta)',
          modelFeatures: { intelligence: 3, speed: 4 },
        },
        'gemini-3.6-flash-low': {
          name: 'Gemini 3.6 Flash (Düşük)',
          modelFeatures: { intelligence: 2, speed: 5 },
        },
        'gemini-3.1-pro-high': {
          name: 'Gemini 3.1 Pro (Yüksek)',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'gemini-3.1-pro-low': {
          name: 'Gemini 3.1 Pro (Düşük)',
          modelFeatures: { intelligence: 4, speed: 3 },
        },
        'claude-opus-5-5-low': {
          name: 'Claude Opus 5.5 (Düşük)',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'claude-opus-5-5-medium': {
          name: 'Claude Opus 5.5 (Orta)',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'claude-opus-5-5-high': {
          name: 'Claude Opus 5.5 (Yüksek)',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'claude-sonnet-5-5-low': {
          name: 'Claude Sonnet 5.5 (Düşük)',
          modelFeatures: { intelligence: 4, speed: 3 },
        },
        'claude-sonnet-5-5-medium': {
          name: 'Claude Sonnet 5.5 (Orta)',
          modelFeatures: { intelligence: 4, speed: 3 },
        },
        'claude-sonnet-5-5-high': {
          name: 'Claude Sonnet 5.5 (Yüksek)',
          modelFeatures: { intelligence: 4, speed: 3 },
        },
        'claude-sonnet-4-6': {
          name: 'Claude Sonnet 4.6 (Düşünen)',
          modelFeatures: { intelligence: 4, speed: 3 },
        },
        'claude-opus-4-6-thinking': {
          name: 'Claude Opus 4.6 (Düşünen)',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'gpt-oss-120b-medium': {
          name: 'GPT-OSS 120B (Orta)',
          modelFeatures: { intelligence: 3, speed: 3 },
        },
      },
    },
    hostDependency: {
      id: 'antigravity',
      binaryNames: ['agy', 'antigravity'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
          },
        ],
        linux: [
          {
            method: 'curl',
            command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
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
      kind: 'argv',
      flag: '-i',
    },
    sessions: {
      kind: 'resumable',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  acp: {
    buildSpawn: (ctx) => ({
      command: process.execPath,
      args: [resolveAdapterAsset(antigravityAdapter)],
      env: { ELECTRON_RUN_AS_NODE: '1', ORKESTRA_AGY_EXECUTABLE: ctx.cli },
    }),
    connect: connectStdioAcp,
  },
  mcp: passthroughMcpAdapter('.gemini/config/mcp_config.json'),
  hooks: buildAntigravityHookConfig(),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--dangerously-skip-permissions',
        initialPromptFlag: '-i',
        // --conversation resumes an existing native agy session by id; passing an
        // unknown id makes agy warn and mint a fresh session, so only pass the
        // hook-captured native id on resume and fall back to -c (most recent).
        resumeFlag: '--conversation=',
        sessionIdFlag: '--conversation=',
        sessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '-c',
        modelFlag: '--model',
      }),
  },
});
