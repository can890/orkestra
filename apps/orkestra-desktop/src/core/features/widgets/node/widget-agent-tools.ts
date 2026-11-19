import { randomBytes } from 'node:crypto';
import { validateWidgetInput, WIDGET_TOOL_NAME } from '@orkestra/core/runtimes/acp/api/client';
import type { Logger } from '@orkestra/shared/logger';
import type {
  AgentToolCallResult,
  AgentToolsMcpServer,
  ConversationMcpServerProvider,
  ConversationToolContext,
} from '@core/services/agent-tools/api/agent-tools';
import { AGENT_TOOLS_BRIDGE_ENV } from '@core/services/agent-tools/node/agent-tools-bridge';
import type { AgentToolsBridgeHost } from '@core/services/agent-tools/node/agent-tools-host';
import {
  WIDGET_SERVER_NAME,
  WIDGET_TOOLS,
  WIDGET_TOOLS_INSTRUCTIONS,
  WIDGET_TOOLS_SERVER_ID,
} from './widget-tool-definitions';

export type WidgetAgentToolsDeps = {
  /** Paylaşılan ajan araçları altyapısı (RPC sunucusu, köprü, uzak tüneller). */
  tools: AgentToolsBridgeHost;
  /** "Sohbet widget'ları" ayarı; kapalıysa sunucu hiç eklenmez ve çağrılar reddedilir. */
  isEnabled(): Promise<boolean>;
  logger: Logger;
};

/**
 * Her ACP konuşmasına `orkestra-widgets` MCP sunucusunu ekler (ayarla kapatılabilir). Araç yalnızca
 * girdiyi doğrular ve ajana "gösterildi" der; çizimi sohbet arayüzü yapar. Girdi, aracın çağrısı
 * olarak transcript'te kalır ve oradan çizilir: sunucu hiçbir içeriği saklamaz, dosya ya da ağ
 * erişimi yoktur ve ajana yeni bir yetki vermez.
 */
export class WidgetAgentTools implements ConversationMcpServerProvider {
  private readonly tokens = new Map<string, string>();
  private readonly conversationsByToken = new Map<string, string>();
  private readonly unregister: () => void;

  constructor(private readonly deps: WidgetAgentToolsDeps) {
    this.unregister = deps.tools.register({
      id: WIDGET_TOOLS_SERVER_ID,
      authenticate: (token) => this.conversationsByToken.get(token) ?? null,
      handle: (conversationId, method, params) => this.handle(conversationId, method, params),
    });
  }

  async conversationMcpServers(context: ConversationToolContext): Promise<AgentToolsMcpServer[]> {
    if (!(await this.deps.isEnabled())) return [];
    const server = await this.deps.tools.bridgeServer({
      name: WIDGET_SERVER_NAME,
      host: context.host,
      token: this.tokenFor(context.conversationId),
      env: AGENT_TOOLS_BRIDGE_ENV,
      serverId: WIDGET_TOOLS_SERVER_ID,
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
        name: WIDGET_SERVER_NAME,
        instructions: WIDGET_TOOLS_INSTRUCTIONS,
        tools: WIDGET_TOOLS,
      };
    }
    if (method !== 'call') throw new Error(`Unknown method: ${method}`);
    const name = typeof params.name === 'string' ? params.name : '';
    if (name !== WIDGET_TOOL_NAME) return failure(`Unknown tool: ${name}`);
    // Ayar çalışan oturumlar için de geçerli: kapatılınca ajan widget gösteremez.
    if (!(await this.deps.isEnabled())) {
      return failure('Widgets are turned off in Orkestra settings; describe the result in text.');
    }
    const checked = validateWidgetInput(params.arguments);
    if (!checked.success) return failure(`Widget rejected: ${checked.error}`);
    this.deps.logger.debug('Orkestra widget gösterildi', { conversationId });
    return {
      content: [
        {
          type: 'text',
          text: `Widget "${checked.data.title}" is now shown in the conversation. The user can see and use it; you do not need to repeat its content.`,
        },
      ],
    } satisfies AgentToolCallResult;
  }
}

function failure(message: string): AgentToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
