import { randomBytes } from 'node:crypto';
import type { Logger } from '@orkestra/shared/logger';
import type {
  AgentToolCallResult,
  AgentToolsMcpServer,
  ConversationMcpServerProvider,
  ConversationToolContext,
} from '@core/services/agent-tools/api/agent-tools';
import { AGENT_TOOLS_BRIDGE_ENV } from '@core/services/agent-tools/node/agent-tools-bridge';
import type { AgentToolsBridgeHost } from '@core/services/agent-tools/node/agent-tools-host';
import type { MemoryError } from '../api/memory-model';
import {
  MEMORY_MCP_SERVER_NAME,
  MEMORY_TOOLS,
  MEMORY_TOOLS_INSTRUCTIONS,
  MEMORY_TOOLS_SERVER_ID,
} from './memory-tool-definitions';
import type { ProjectMemoryService } from './project-memory-service';

export type MemoryAgentToolsDeps = {
  tools: AgentToolsBridgeHost;
  memory: ProjectMemoryService;
  logger: Logger;
};

/**
 * Ortak proje hafızasını, ayarı açık projelerin ACP/TUI konuşmalarına "orkestra-memory" MCP
 * sunucusu olarak sunar. Proje kimliği ajandan alınmaz: konuşmanın belirteci köprüde bir
 * konuşmaya, bağlama ise sunucu eklenirken çözülen projeye bağlanır; araç argümanlarında proje
 * alanı yoktur. Ayar kapalıysa sunucu eklenmez; oturum sırasında kapatılırsa çağrılar reddedilir.
 */
export class MemoryAgentTools implements ConversationMcpServerProvider {
  private readonly tokens = new Map<string, string>();
  private readonly conversationsByToken = new Map<string, string>();
  private readonly projects = new Map<string, string>();
  private readonly unregister: () => void;

  constructor(private readonly deps: MemoryAgentToolsDeps) {
    this.unregister = deps.tools.register({
      id: MEMORY_TOOLS_SERVER_ID,
      authenticate: (token) => this.conversationsByToken.get(token) ?? null,
      handle: (conversationId, method, params) => this.handle(conversationId, method, params),
    });
  }

  async conversationMcpServers(context: ConversationToolContext): Promise<AgentToolsMcpServer[]> {
    if (!(await this.deps.memory.isEnabled(context.projectId))) return [];
    this.projects.set(context.conversationId, context.projectId);
    const server = await this.deps.tools.bridgeServer({
      name: MEMORY_MCP_SERVER_NAME,
      host: context.host,
      token: this.tokenFor(context.conversationId),
      env: AGENT_TOOLS_BRIDGE_ENV,
      serverId: MEMORY_TOOLS_SERVER_ID,
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
    const projectId = this.projects.get(conversationId);
    if (!projectId) throw new Error('This conversation has no access to project memory.');
    if (method === 'describe') {
      return {
        name: MEMORY_MCP_SERVER_NAME,
        instructions: MEMORY_TOOLS_INSTRUCTIONS,
        tools: MEMORY_TOOLS,
      };
    }
    if (method !== 'call') throw new Error(`Unknown method: ${method}`);
    if (!(await this.deps.memory.isEnabled(projectId))) {
      return textResult('Shared project memory is turned off for this project.', true);
    }
    const tool = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    this.deps.logger.debug('Orkestra hafıza aracı çağrıldı', { conversationId, tool });
    return this.run(projectId, tool, args);
  }

  private async run(
    projectId: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<AgentToolCallResult> {
    const { memory } = this.deps;
    switch (tool) {
      case 'memory_list': {
        const result = await memory.list(projectId);
        if (!result.success) return errorResult(result.error);
        if (result.data.length === 0) return textResult('No memories saved for this project yet.');
        return textResult(
          result.data.map((e) => `- ${e.name} (${e.size} bytes): ${e.description}`).join('\n')
        );
      }
      case 'memory_read': {
        const result = await memory.read(projectId, args.name as string);
        if (!result.success) return errorResult(result.error);
        return textResult(
          `# ${result.data.name}\n${result.data.description}\n\n${result.data.content}`
        );
      }
      case 'memory_write': {
        const result = await memory.write(projectId, {
          name: args.name as string,
          description: args.description as string,
          content: args.content as string,
        });
        if (!result.success) return errorResult(result.error);
        return textResult(`Saved memory "${result.data.name}" (${result.data.size} bytes).`);
      }
      case 'memory_delete': {
        const result = await memory.remove(projectId, args.name as string);
        if (!result.success) return errorResult(result.error);
        return textResult('Memory deleted.');
      }
      default:
        return textResult(`Unknown tool: ${tool}`, true);
    }
  }
}

function textResult(text: string, isError = false): AgentToolCallResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function errorResult(error: MemoryError): AgentToolCallResult {
  return textResult(error.message, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
