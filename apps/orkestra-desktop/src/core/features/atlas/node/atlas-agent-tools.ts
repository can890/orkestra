import { randomBytes } from 'node:crypto';
import type { Logger } from '@orkestra/shared/logger';
import { wrapUntrustedNotes } from '@core/features/atlas/api/atlas-model';
import type {
  AgentToolCallResult,
  AgentToolsMcpServer,
  ConversationMcpServerProvider,
  ConversationToolContext,
} from '@core/services/agent-tools/api/agent-tools';
import { AGENT_TOOLS_BRIDGE_ENV } from '@core/services/agent-tools/node/agent-tools-bridge';
import type { AgentToolsBridgeHost } from '@core/services/agent-tools/node/agent-tools-host';
import type { AtlasService } from './atlas-service';
import {
  ATLAS_MCP_SERVER_NAME,
  ATLAS_TOOLS,
  ATLAS_TOOLS_INSTRUCTIONS,
  ATLAS_TOOLS_SERVER_ID,
} from './atlas-tool-definitions';

export type AtlasAgentToolsDeps = {
  tools: AgentToolsBridgeHost;
  atlas: Pick<AtlasService, 'isSearchEnabled' | 'search' | 'projectHistory'>;
  logger: Logger;
};

/**
 * "Atlas'ı bilgi kaynağı olarak kullan" ayarı açıkken her konuşmaya salt okunur
 * `orkestra-atlas` MCP sunucusunu ekler. Atlas CLI masaüstünde çalışır; uzak konuşmalarda da
 * köprü masaüstüne döner. Proje kimliği ajandan alınmaz, konuşmanın bağlamından gelir.
 */
export class AtlasAgentTools implements ConversationMcpServerProvider {
  private readonly tokens = new Map<string, string>();
  private readonly conversationsByToken = new Map<string, string>();
  private readonly projects = new Map<string, string>();
  private readonly unregister: () => void;

  constructor(private readonly deps: AtlasAgentToolsDeps) {
    this.unregister = deps.tools.register({
      id: ATLAS_TOOLS_SERVER_ID,
      authenticate: (token) => this.conversationsByToken.get(token) ?? null,
      handle: (conversationId, method, params) => this.handle(conversationId, method, params),
    });
  }

  async conversationMcpServers(context: ConversationToolContext): Promise<AgentToolsMcpServer[]> {
    if (!(await this.deps.atlas.isSearchEnabled())) return [];
    this.projects.set(context.conversationId, context.projectId);
    const server = await this.deps.tools.bridgeServer({
      name: ATLAS_MCP_SERVER_NAME,
      host: context.host,
      token: this.tokenFor(context.conversationId),
      env: AGENT_TOOLS_BRIDGE_ENV,
      serverId: ATLAS_TOOLS_SERVER_ID,
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
    if (method === 'describe') {
      return {
        name: ATLAS_MCP_SERVER_NAME,
        instructions: ATLAS_TOOLS_INSTRUCTIONS,
        tools: ATLAS_TOOLS,
      };
    }
    if (method !== 'call') throw new Error(`Unknown method: ${method}`);
    const tool = typeof params.name === 'string' ? params.name : '';
    const args =
      typeof params.arguments === 'object' && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {};
    this.deps.logger.debug('Orkestra Atlas aracı çağrıldı', { conversationId, tool });
    return this.run(conversationId, tool, args);
  }

  private async run(
    conversationId: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<AgentToolCallResult> {
    switch (tool) {
      case 'atlas_search': {
        const result = await this.deps.atlas.search(args.query, args.limit);
        if (!result.success) return textResult(result.error.message, true);
        return textResult(wrapUntrustedNotes('atlas ara', result.data));
      }
      case 'atlas_project_history': {
        const projectId = this.projects.get(conversationId);
        if (!projectId) return textResult('This conversation has no project.', true);
        const result = await this.deps.atlas.projectHistory(projectId);
        if (!result.success) return textResult(result.error.message, true);
        return textResult(wrapUntrustedNotes('atlas gecmis', result.data));
      }
      default:
        return textResult(`Unknown tool: ${tool}`, true);
    }
  }
}

function textResult(text: string, isError = false): AgentToolCallResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}
