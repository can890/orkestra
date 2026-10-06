import type { Logger } from '@orkestra/shared/logger';
import type {
  AgentToolsMcpServer,
  ConversationMcpServerProvider,
  ConversationToolContext,
} from '@core/services/agent-tools/api/agent-tools';

/** Uzak bir sağlayıcı SSH gidiş-dönüşü gerektirebilir; oturum başlangıcını uzun süre tutmamalı. */
export const CONVERSATION_MCP_PROVIDER_TIMEOUT_MS = 10_000;

function withProviderTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out preparing the MCP server')), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Konuşmaya özel MCP sunucularını (ör. Orkestra tarayıcı araçları) tüm sağlayıcılardan toplar.
 * ACP ve TUI konuşmaları aynı yolu kullanır. Hata veren ya da zaman aşımına uğrayan sağlayıcı
 * günlüğe yazılır ve atlanır; `reserved` adlar ve tekrar eden adlar eklenmez. Asla hata fırlatmaz.
 */
export async function collectConversationMcpServers(params: {
  providers: readonly ConversationMcpServerProvider[];
  context: ConversationToolContext;
  logger: Logger;
  /** Zaten var olan (değiştirilmemesi gereken) sunucu adları, ör. şefin `orkestra` sunucusu. */
  reserved?: Iterable<string>;
  timeoutMs?: number;
}): Promise<AgentToolsMcpServer[]> {
  const timeoutMs = params.timeoutMs ?? CONVERSATION_MCP_PROVIDER_TIMEOUT_MS;
  const provided = await Promise.all(
    params.providers.map(async (provider) => {
      try {
        return await withProviderTimeout(
          provider.conversationMcpServers(params.context),
          timeoutMs
        );
      } catch (error) {
        params.logger.warn('Conversation MCP server unavailable; starting the session without it', {
          conversationId: params.context.conversationId,
          error: String(error),
        });
        return [];
      }
    })
  );
  const names = new Set(params.reserved ?? []);
  return provided.flat().filter((server) => {
    if (names.has(server.name)) return false;
    names.add(server.name);
    return true;
  });
}
