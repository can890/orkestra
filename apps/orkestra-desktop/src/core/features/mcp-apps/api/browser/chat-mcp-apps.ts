import type { ChatMcpAppCall, ChatMcpAppHost, ChatMcpAppView } from '@orkestra/chat-ui';
import type { HostRef } from '@orkestra/core/primitives/host/api';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import type { McpAppViewDto } from '../contract';
import { getMcpAppsClient, type McpAppsClient } from './client';

type Fallible<T> =
  | { success: true; data: T }
  | { success: false; error: { type: string; message: string } };

function unwrap<T>(result: Fallible<T>): T {
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}

export function toChatMcpAppView(app: McpAppViewDto): ChatMcpAppView {
  return {
    server: app.server,
    tool: app.tool,
    resourceUri: app.resourceUri,
    html: app.html,
    ...(app.csp ? { csp: app.csp } : {}),
    ...(app.permissions ? { permissions: app.permissions } : {}),
    ...(app.prefersBorder !== undefined ? { prefersBorder: app.prefersBorder } : {}),
    ...(app.input ? { input: app.input } : {}),
    ...(app.result ? { result: app.result } : {}),
    ...(app.toolDefinition !== undefined ? { toolDefinition: app.toolDefinition } : {}),
    live: app.live,
  };
}

/**
 * Sohbet arayüzüne verilen MCP Apps ana makine servisleri. Uygulamanın kendisi bunlara erişemez;
 * sohbet arayüzündeki aracı istekleri denetler ve onay aldıktan sonra burayı çağırır.
 */
export function createChatMcpAppHost(params: {
  conversationId: string;
  providerId: string;
  host: HostRef;
  /** Sohbete mesaj gönderir; canlı eylemler kapalıysa verilmez. */
  sendMessage?: (text: string) => Promise<void>;
  client?: () => Promise<McpAppsClient>;
}): ChatMcpAppHost {
  const client = params.client ?? getMcpAppsClient;
  const resolved = new Map<string, Promise<ChatMcpAppView | null>>();
  const ref = (call: ChatMcpAppCall) => ({
    conversationId: params.conversationId,
    toolCallId: call.toolCallId,
  });
  const appHost: ChatMcpAppHost = {
    hostName: 'orkestra',
    hostVersion: '0.0.0',
    resolve: (call) => {
      let pending = resolved.get(call.toolCallId);
      if (!pending) {
        pending = (async () => {
          const result = unwrap(
            await (
              await client()
            ).resolve({
              ...ref(call),
              providerId: params.providerId,
              host: params.host,
              server: call.server,
              tool: call.tool,
              ...(call.input ? { input: call.input } : {}),
              ...(call.result ? { result: call.result } : {}),
            })
          );
          if (result.status !== 'ready') return null;
          appHost.hostVersion = result.app.hostVersion;
          return toChatMcpAppView(result.app);
        })();
        // Geçici bir hata kalıcı olarak önbelleğe alınmaz.
        pending.catch(() => resolved.delete(call.toolCallId));
        resolved.set(call.toolCallId, pending);
      }
      return pending;
    },
    toolInfo: async (call, name) => unwrap(await (await client()).toolInfo({ ...ref(call), name })),
    callTool: async (call, name, args) =>
      unwrap(await (await client()).callTool({ ...ref(call), name, arguments: args })),
    readResource: async (call, uri) =>
      unwrap(await (await client()).readResource({ ...ref(call), uri })),
    openLink: async (url) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened.');
      const opened = await openExternal(url);
      if (!opened.success) throw new Error(opened.error ?? 'The link could not be opened.');
    },
    ...(params.sendMessage ? { sendMessage: params.sendMessage } : {}),
  };
  return appHost;
}

/** Sohbet deposunun bir uygulama mesajı göndermek için gereken kısmı. */
export type McpAppMessageTarget<A> = {
  readonly liveActionsEnabled: boolean;
  readonly draftText: string;
  readonly draftAttachments: A[];
  readonly affordances: { readonly isWorking: boolean };
  submitPrompt(
    text: string,
    attachments: A[],
    hiddenContext?: undefined,
    placement?: 'queue'
  ): void;
  setDraftText(text: string): void;
  addDraftAttachments(attachments: A[]): void;
};

/**
 * Onaylanmış bir uygulama mesajını kullanıcı mesajı olarak gönderir. Ajan çalışıyorsa sıraya
 * alınır. Kullanıcının yazmakta olduğu taslak (metin ve ekler) korunur.
 */
export async function submitMcpAppMessage<A>(
  target: McpAppMessageTarget<A>,
  text: string
): Promise<void> {
  if (!target.liveActionsEnabled) {
    throw new Error('Messages cannot be sent in this conversation right now.');
  }
  const draft = target.draftText;
  const attachments = [...target.draftAttachments];
  target.submitPrompt(text, [], undefined, target.affordances.isWorking ? 'queue' : undefined);
  if (draft) target.setDraftText(draft);
  if (attachments.length > 0) target.addDraftAttachments(attachments);
}
