import { randomBytes } from 'node:crypto';
import type { Logger } from '@orkestra/shared/logger';
import type { AgentBrowserPort } from '@core/primitives/browser/api/agent-browser';
import type {
  AgentToolsMcpServer,
  ConversationMcpServerProvider,
  ConversationToolContext,
} from '@core/services/agent-tools/api/agent-tools';
import { AGENT_TOOLS_BRIDGE_ENV } from '@core/services/agent-tools/node/agent-tools-bridge';
import type { AgentToolsBridgeHost } from '@core/services/agent-tools/node/agent-tools-host';
import {
  BROWSER_MCP_SERVER_NAME,
  BROWSER_TOOLS,
  BROWSER_TOOLS_INSTRUCTIONS,
  BROWSER_TOOLS_SERVER_ID,
} from './browser-tool-definitions';
import {
  BrowserToolRunner,
  type BrowserToolSession,
  type BrowserToolTiming,
} from './browser-tool-runner';
import {
  LoopbackForwarder,
  type BrowserToolScope,
  type LoopbackForwardBackend,
} from './loopback-forwarding';

export type BrowserAgentToolsDeps = {
  /** Paylaşılan ajan araçları altyapısı (RPC sunucusu, köprü, uzak tüneller). */
  tools: AgentToolsBridgeHost;
  /** Ana sürecin uygulama içi tarayıcısı; bootstrap'ta bağlanır. */
  browser: AgentBrowserPort;
  /** Uzak loopback adresleri için mevcut önizleme yönlendirmeleri. */
  previewServers: LoopbackForwardBackend;
  logger: Logger;
  timing?: Partial<BrowserToolTiming>;
};

/**
 * Orkestra'nın uygulama içi tarayıcısını her ACP konuşmasına "orkestra-browser" MCP sunucusu
 * olarak sunar. Her konuşma bellekte tutulan rastgele bir belirteç alır; belirteç konuşmayı
 * görevine (proje, çalışma alanı, görev, makine) bağlar ve tüm çağrılar o görevin sekmeleriyle
 * sınırlıdır. Konuşmanın güncel sekmesi de bellekte tutulur.
 */
export class BrowserAgentTools implements ConversationMcpServerProvider {
  private readonly tokens = new Map<string, string>();
  private readonly conversationsByToken = new Map<string, string>();
  private readonly scopes = new Map<string, BrowserToolScope>();
  private readonly currentTabs = new Map<string, string>();
  private readonly runner: BrowserToolRunner;
  private readonly unregister: () => void;

  constructor(private readonly deps: BrowserAgentToolsDeps) {
    this.runner = new BrowserToolRunner({
      browser: deps.browser,
      urls: new LoopbackForwarder(deps.previewServers),
      ...(deps.timing ? { timing: deps.timing } : {}),
    });
    this.unregister = deps.tools.register({
      id: BROWSER_TOOLS_SERVER_ID,
      authenticate: (token) => this.conversationsByToken.get(token) ?? null,
      handle: (conversationId, method, params) => this.handle(conversationId, method, params),
    });
  }

  async conversationMcpServers(context: ConversationToolContext): Promise<AgentToolsMcpServer[]> {
    // Hazırlanmamış görevin çalışma alanı yoktur; tarayıcı sekmesi açılamaz.
    if (!context.workspaceId) return [];
    this.scopes.set(context.conversationId, {
      conversationId: context.conversationId,
      projectId: context.projectId,
      workspaceId: context.workspaceId,
      taskId: context.taskId,
      host: context.host,
    });
    const server = await this.deps.tools.bridgeServer({
      name: BROWSER_MCP_SERVER_NAME,
      host: context.host,
      token: this.tokenFor(context.conversationId),
      env: AGENT_TOOLS_BRIDGE_ENV,
      serverId: BROWSER_TOOLS_SERVER_ID,
    });
    return server ? [server] : [];
  }

  dispose(): void {
    this.unregister();
  }

  private tokenFor(conversationId: string): string {
    let token = this.tokens.get(conversationId);
    if (!token) {
      token = randomBytes(32).toString('hex');
      this.tokens.set(conversationId, token);
      this.conversationsByToken.set(token, conversationId);
    }
    return token;
  }

  private async handle(
    conversationId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const scope = this.scopes.get(conversationId);
    if (!scope) throw new Error('This conversation has no access to the in-app browser.');
    if (method === 'describe') {
      return {
        name: BROWSER_MCP_SERVER_NAME,
        instructions: BROWSER_TOOLS_INSTRUCTIONS,
        tools: BROWSER_TOOLS,
      };
    }
    if (method !== 'call') throw new Error(`Unknown method: ${method}`);
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    this.deps.logger.debug('Orkestra tarayıcı aracı çağrıldı', { conversationId, tool: name });
    return this.runner.run(this.session(scope), name, args);
  }

  private session(scope: BrowserToolScope): BrowserToolSession {
    const conversationId = scope.conversationId;
    return {
      scope,
      currentTab: () => this.currentTabs.get(conversationId) ?? null,
      setCurrentTab: (browserId) => {
        if (browserId) this.currentTabs.set(conversationId, browserId);
        else this.currentTabs.delete(conversationId);
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
