// Kullanıcının eklediği bir ACP ajanını, yerleşik ajanlarla aynı genel/native ACP yoluna
// bağlanan gerçek bir eklenti sağlayıcısına çevirir. Çalışma zamanı çatallanmaz: süreç başlatma,
// oturum, izinler, terminaller ve MCP enjeksiyonu yerleşik ajanlarla aynı koddan geçer.
import { basename } from 'node:path';
import {
  definePlugin,
  registerPluginBehavior,
  type AgentAuthDescriptor,
  type CLIAgentPluginProvider,
} from '@orkestra/core/services/agent-plugins/api/plugins';
import { passthroughMcpAdapter } from '@orkestra/core/services/agent-plugins/api/plugins/helpers';
import type { PluginIconAsset } from '@orkestra/shared/plugins';
import { createNativeAcpBehavior } from '../helpers/acp-stdio';
import { enrichRunSubagentOnly } from '../helpers/run-subagent';
import type { CustomAcpAgent } from './schema';

const DEFAULT_ICON_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M8 10.5 10.5 12 8 13.5"/><path d="M12.5 14h3.5"/></svg>`;

export function customAcpIcon(
  agent: Pick<CustomAcpAgent, 'name' | 'iconDataUri'>
): PluginIconAsset {
  if (agent.iconDataUri) {
    return {
      kind: 'image',
      alt: agent.name,
      // Kayıt ikonları tek renkli (siyah) SVG'lerdir; koyu temada ters çevrilir.
      invertInDark: true,
      variants: [{ minSize: 0, light: agent.iconDataUri }],
    };
  }
  return { kind: 'svg', alt: agent.name, variants: [{ minSize: 0, light: DEFAULT_ICON_SVG }] };
}

/** ACP `authMethods` → Orkestra giriş yöntemleri (terminal girişi ve ortam değişkeni anahtarı). */
export function customAcpAuthDescriptor(agent: CustomAcpAgent): AgentAuthDescriptor {
  const methods: Extract<AgentAuthDescriptor, { kind: 'supported' }>['methods'] = [];
  for (const method of agent.probe?.authMethods ?? []) {
    if (method.type === 'terminal') {
      methods.push({
        kind: 'cli-login',
        id: method.id,
        name: method.name,
        args: method.args ?? [],
        ...(method.description ? { description: method.description } : {}),
      });
    } else if (method.type === 'env_var' && method.vars && method.vars.length > 0) {
      methods.push({
        kind: 'api-key',
        id: method.id,
        name: method.name,
        envVars: method.vars.map((variable) => ({
          name: variable.name,
          label: variable.label ?? variable.name,
        })),
        ...(method.link ? { helpUrl: method.link } : {}),
      });
    }
  }
  return methods.length > 0 ? { kind: 'supported', methods } : { kind: 'none' };
}

/** Kullanıcı ajanı MCP yapılandırmasının ev dizinine göre yolu (Orkestra'ya ait dosya). */
export function customAcpMcpConfigPath(id: string): string {
  return `.orkestra/acp-agents/${id}/mcp.json`;
}

export function createCustomAcpProvider(agent: CustomAcpAgent): CLIAgentPluginProvider {
  const models = agent.probe?.models ?? [];
  const auth = customAcpAuthDescriptor(agent);
  const website = agent.registry?.website ?? agent.registry?.repository ?? '';
  const plugin = definePlugin(
    {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      websiteUrl: website,
    },
    {
      acp: { kind: 'supported' },
      auth,
      models:
        models.length > 0
          ? {
              kind: 'selectable',
              modelOptions: Object.fromEntries(
                models.map((model) => [model.id, { name: model.name }])
              ),
            }
          : { kind: 'none' },
      mcp: {
        kind: 'supported',
        scope: 'global',
        supportedTransports: agent.probe?.mcp.http ? ['stdio', 'http'] : ['stdio'],
      },
      hostDependency: {
        id: agent.id,
        binaryNames: [basename(agent.launch.command) || agent.id],
        ...(website ? { installDocs: website } : {}),
      },
      prompt: { kind: 'none' },
      sessions: { kind: agent.probe?.loadSession ? 'resumable' : 'stateless' },
    },
    { icon: customAcpIcon(agent) }
  );

  const launch = agent.launch;
  return registerPluginBehavior(plugin, {
    acp: {
      ...createNativeAcpBehavior(() => ({
        command: launch.command,
        args: [...launch.args],
        env: { ...launch.env },
        ...(launch.cwd ? { cwd: launch.cwd } : {}),
      })),
      // Orkestra'nın `run_subagent` aracını alt ajan paneline taşır.
      enrich: enrichRunSubagentOnly,
    },
    ...(auth.kind === 'supported'
      ? {
          auth: {
            // ACP ajanının giriş durumu yalnızca oturum açılırken anlaşılır; burada tahmin yok.
            checkStatus: async () => ({ kind: 'unknown' as const }),
            buildLoginCommand: (_ctx: { cli: string }, methodId: string) => {
              const method = agent.probe?.authMethods.find((m) => m.id === methodId);
              if (!method || method.type !== 'terminal') return null;
              return { command: launch.command, args: [...(method.args ?? [])] };
            },
          },
        }
      : {}),
    hostDependency: { resolveExecutable: () => launch.command },
    mcp: passthroughMcpAdapter(customAcpMcpConfigPath(agent.id)),
  });
}
