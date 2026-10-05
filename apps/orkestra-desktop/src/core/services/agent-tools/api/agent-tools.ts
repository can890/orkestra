import type { HostRef } from '@orkestra/core/primitives/host/api';

/**
 * Bir konuşmanın ACP oturumuna eklenecek stdio MCP sunucusu. ACP çekirdeğindeki
 * `AcpSessionMcpServer` ile yapısal olarak aynıdır; ACP girdisine doğrudan eklenebilir.
 */
export type AgentToolsMcpServer = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
};

/** Konuşmaya özel araç sunucusu hazırlanırken bilinen kapsam. */
export type ConversationToolContext = Readonly<{
  conversationId: string;
  projectId: string;
  taskId: string;
  /** Görevin çalışma alanı; görev henüz hazırlanmadıysa null. */
  workspaceId: string | null;
  host: HostRef;
}>;

/**
 * Her ACP konuşmasının oturumuna kendi MCP sunucusunu ekleyen sağlayıcı (ör. Orkestra tarayıcı
 * araçları). Konuşmalar denetleyicisi bağlanma (attach) sırasında çağırır; hata fırlatan bir
 * sağlayıcı konuşmanın başlamasını engellemez, yalnızca sunucusu eklenmez.
 */
export interface ConversationMcpServerProvider {
  conversationMcpServers(context: ConversationToolContext): Promise<AgentToolsMcpServer[]>;
}

/** MCP araç sonucunun içerik blokları; köprü bunları ajana olduğu gibi iletir. */
export type AgentToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/** Bir araç sunucusunun `call` yanıtı. */
export type AgentToolCallResult = {
  content: AgentToolContent[];
  isError?: boolean;
};
