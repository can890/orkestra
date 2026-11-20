import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  definePlugin,
  registerPluginBehavior,
  type CommandContext,
} from '@orkestra/core/services/agent-plugins/api/plugins';
import {
  buildStandardCommand,
  passthroughMcpAdapter,
} from '@orkestra/core/services/agent-plugins/api/plugins/helpers';
import { connectStdioAcp } from '../../helpers/acp-stdio';
import { resolveAdapterAsset } from '../../helpers/adapter-assets';
import { enrichAntigravityUpdate } from './acp-transform';
import { antigravityAdapter } from './adapter';
import { buildAntigravityHookConfig } from './hooks';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'antigravity',
    name: 'Antigravity',
    description: 'Ortak Antigravity ayarları ve sohbet geçmişiyle terminal ve sohbet oturumları.',
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
        'gemini-4-neon-high': {
          name: 'Gemini 4 Neon (Yüksek)',
          modelFeatures: { intelligence: 5, speed: 3 },
        },
        'gemini-4-neon-xhigh': {
          name: 'Gemini 4 Neon (Çok Yüksek)',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'gemini-4-neon-medium': {
          name: 'Gemini 4 Neon (Orta)',
          modelFeatures: { intelligence: 4, speed: 4 },
        },
        'gemini-4-neon-low': {
          name: 'Gemini 4 Neon (Düşük)',
          modelFeatures: { intelligence: 4, speed: 5 },
        },
        'gemini-4-carbon-high': {
          name: 'Gemini 4 Carbon (Yüksek)',
          modelFeatures: { intelligence: 5, speed: 1 },
        },
        'gemini-4-carbon-medium': {
          name: 'Gemini 4 Carbon (Orta)',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'gemini-4-carbon-low': {
          name: 'Gemini 4 Carbon (Düşük)',
          modelFeatures: { intelligence: 5, speed: 3 },
        },
        'gemini-4-argon-medium': {
          name: 'Gemini 4 Argon (Orta)',
          modelFeatures: { intelligence: 5, speed: 3 },
        },
        'gemini-4-argon-high': {
          name: 'Gemini 4 Argon (Yüksek)',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'gemini-4-argon-low': {
          name: 'Gemini 4 Argon (Düşük)',
          modelFeatures: { intelligence: 4, speed: 3 },
        },
        'gemini-4-hydrogen-xhigh': {
          name: 'Gemini 4 Hydrogen (Çok Yüksek)',
          modelFeatures: { intelligence: 5, speed: 3 },
        },
        'gemini-4-hydrogen-high': {
          name: 'Gemini 4 Hydrogen (Yüksek)',
          modelFeatures: { intelligence: 4, speed: 4 },
        },
        'gemini-4-hydrogen-medium': {
          name: 'Gemini 4 Hydrogen (Orta)',
          modelFeatures: { intelligence: 4, speed: 5 },
        },
        'gemini-4-hydrogen-low': {
          name: 'Gemini 4 Hydrogen (Düşük)',
          modelFeatures: { intelligence: 3, speed: 5 },
        },
        'gemini-pro-orchestrator': {
          name: 'Orchestrator (Carbon)',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'gemini-pro-orchestrator-argon': {
          name: 'Orchestrator (Argon)',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'gemini-pro-orchestrator-neon': {
          name: 'Orchestrator (Neon)',
          modelFeatures: { intelligence: 5, speed: 3 },
        },
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ACP köprüsü yeni oturuma kendi UUID'sini verir ve ilk yanıtta agy'nin gerçek `nativeId`
 * kimliğini `~/.local/state/orkestra/antigravity/<id>.json` dosyasına kaydeder. Sohbetten
 * terminale geçerken bu eşlemeyi çözerek agy'nin aynı konuşmayı `--conversation=` ile açmasını
 * sağlar; henüz mesaj gönderilmemiş boş ACP oturumunda ise temiz yeni terminal başlatır.
 */
function resolveAntigravityResumeContext(ctx: CommandContext): CommandContext {
  if (!ctx.isResuming || !ctx.providerSessionId || !UUID_PATTERN.test(ctx.providerSessionId)) {
    return ctx;
  }
  const stateDir =
    ctx.env?.ORKESTRA_AGY_STATE_DIR ||
    process.env.ORKESTRA_AGY_STATE_DIR ||
    join(ctx.env?.HOME || homedir(), '.local', 'state', 'orkestra', 'antigravity');
  try {
    const raw = readFileSync(join(stateDir, `${ctx.providerSessionId}.json`), 'utf8');
    const parsed = JSON.parse(raw) as { nativeId?: unknown };
    if (typeof parsed.nativeId === 'string' && UUID_PATTERN.test(parsed.nativeId)) {
      return { ...ctx, providerSessionId: parsed.nativeId };
    }
    return { ...ctx, isResuming: false, providerSessionId: undefined };
  } catch {
    return ctx;
  }
}

export const provider = registerPluginBehavior(plugin, {
  acp: {
    buildSpawn: (ctx) => ({
      command: process.execPath,
      args: [resolveAdapterAsset(antigravityAdapter)],
      env: { ELECTRON_RUN_AS_NODE: '1', ORKESTRA_AGY_EXECUTABLE: ctx.cli },
    }),
    connect: connectStdioAcp,
    enrich: enrichAntigravityUpdate,
  },
  mcp: passthroughMcpAdapter('.gemini/config/mcp_config.json'),
  hooks: buildAntigravityHookConfig(),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(resolveAntigravityResumeContext(ctx), {
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
