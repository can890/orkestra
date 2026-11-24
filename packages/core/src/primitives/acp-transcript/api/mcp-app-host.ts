// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/client-runtime/src/mcpApps/host.ts
import {
  MCP_APP_PROTOCOL_VERSION,
  type McpAppCsp,
  type McpAppPermissions,
  type TranscriptMcpCallResult,
} from './mcp-app';

/**
 * MCP Apps ana makine (host) aracısı: korumalı çerçevedeki uygulamanın `postMessage` ile gönderdiği
 * JSON-RPC mesajlarını yanıtlar. DOM'a bağlı değildir; çerçeve, mesajın kaynağını (çerçevenin
 * kendi belgesi) denetledikten sonra `receive` çağırır.
 *
 * Onay kuralları burada uygulanır:
 * - Uygulama yalnızca kendi sunucusundaki araçları çağırabilir; `_meta.ui.visibility` `app`
 *   içermeyen araçlar reddedilir. Salt okunur (`readOnlyHint`) olmayan her çağrı için kullanıcıya
 *   sorulur.
 * - Sohbete gönderilecek her mesaj için kullanıcıya sorulur.
 * - Bilinmeyen istekler `-32601` ile temiz biçimde reddedilir.
 */

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_PENDING_REQUESTS = 16;
const TEARDOWN_TIMEOUT_MS = 2000;
const encoder = new TextEncoder();

type JsonRpcId = string | number;

export type McpAppDisplayMode = 'inline' | 'fullscreen';

export interface McpAppHostContext {
  readonly theme: 'light' | 'dark';
  readonly styles: { readonly variables: Readonly<Record<string, string>> };
  readonly displayMode: McpAppDisplayMode;
  readonly availableDisplayModes: ReadonlyArray<McpAppDisplayMode>;
  /**
   * Satır içinde ana makine çerçeveyi uygulamanın bildirdiği yüksekliğe göre boyutlar
   * (`maxHeight`); tam ekranda çerçeve sabit bir kutudur (`height`).
   */
  readonly containerDimensions:
    | { readonly width: number; readonly maxHeight: number }
    | { readonly width: number; readonly height: number };
  readonly platform: 'web' | 'desktop' | 'mobile';
  readonly locale?: string;
  readonly timeZone?: string;
  readonly userAgent?: string;
  readonly deviceCapabilities?: { readonly touch?: boolean; readonly hover?: boolean };
  readonly safeAreaInsets?: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
  readonly toolInfo?: { readonly tool: unknown };
}

export type McpAppCallToolResult = TranscriptMcpCallResult;

/** Aracın uygulama tarafından çağrılabilirliği (sunucunun araç tanımından). */
export interface McpAppToolInfo {
  readonly callable: boolean;
  readonly readOnly: boolean;
  readonly title?: string;
}

export type McpAppConsentRequest =
  | {
      readonly kind: 'tool';
      readonly server: string;
      readonly tool: string;
      readonly title?: string;
      readonly arguments: Record<string, unknown>;
    }
  | { readonly kind: 'message'; readonly server: string; readonly text: string };

/** Kullanıcıya gösterilecek temiz bir ret; mesajı uygulamaya aynen iletilir. */
export class McpAppHostRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpAppHostRefusal';
  }
}

export interface McpAppHostOptions {
  readonly app: {
    readonly server: string;
    readonly tool: string;
    readonly csp?: McpAppCsp;
    readonly permissions?: McpAppPermissions;
  };
  readonly hostName: string;
  readonly hostVersion: string;
  readonly post: (message: unknown) => void;
  readonly hostContext: () => McpAppHostContext;

  readonly toolInfo: (name: string) => Promise<McpAppToolInfo>;
  readonly callTool: (input: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }) => Promise<McpAppCallToolResult>;
  readonly readResource: (input: { readonly uri: string }) => Promise<unknown>;
  /** Kullanıcı onayı; `true` dışındaki her yanıt ret sayılır. */
  readonly confirm: (request: McpAppConsentRequest) => Promise<boolean>;
  readonly openLink: (url: string) => Promise<void>;
  /** Sohbete mesaj gönderemeyen yerlerde verilmez; istek reddedilir. */
  readonly sendMessage?: (text: string) => Promise<void>;
  readonly requestDisplayMode: (mode: McpAppDisplayMode) => Promise<McpAppDisplayMode>;
  readonly onRequestTeardown: () => void;
  readonly onSizeChanged: (size: { readonly width?: number; readonly height?: number }) => void;
}

export interface McpAppHost {
  /** Uygulamanın gönderdiği bir mesajı işler; kaynağı çağıran denetlemiştir. */
  readonly receive: (data: unknown) => void;
  readonly setToolCall: (call: {
    readonly arguments: unknown;
    readonly result: McpAppCallToolResult | undefined;
  }) => void;
  readonly updateHostContext: () => void;
  /** Uygulamadan kapanmadan önce toparlanmasını ister (`ui/resource-teardown`), sonra kapanır. */
  readonly teardown: () => Promise<void>;
  readonly dispose: () => void;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function stringifyJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

const MCP_CONTENT_BLOCK_STRING_FIELDS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ['text', ['text']],
  ['image', ['data', 'mimeType']],
  ['audio', ['data', 'mimeType']],
  ['resource_link', ['uri', 'name']],
]);

function isMcpContentBlock(block: unknown): boolean {
  if (!isObject(block) || typeof block.type !== 'string') return false;
  if (block.type === 'resource') {
    const resource = block.resource;
    return (
      isObject(resource) &&
      typeof resource.uri === 'string' &&
      (typeof resource.text === 'string' || typeof resource.blob === 'string')
    );
  }
  const fields = MCP_CONTENT_BLOCK_STRING_FIELDS.get(block.type);
  return fields !== undefined && fields.every((field) => typeof block[field] === 'string');
}

/**
 * MCP Apps SDK, kabul etmediği tek bir alan yüzünden tüm bildirimi reddeder (ör. `_meta: null`,
 * MCP'nin tanımlamadığı bir içerik bloğu). Sonuç bu yüzden temizlenir.
 */
export function normalizeMcpAppToolResult(result: McpAppCallToolResult): McpAppCallToolResult {
  return {
    content: Array.isArray(result.content) ? result.content.filter(isMcpContentBlock) : [],
    ...(isObject(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError === true ? { isError: true } : {}),
    ...(isObject(result._meta) ? { _meta: result._meta } : {}),
  };
}

const errorMessage = (error: unknown) =>
  error instanceof McpAppHostRefusal
    ? error.message
    : error instanceof Error && error.message.trim() !== ''
      ? error.message
      : 'Request failed.';

export function makeMcpAppHost(options: McpAppHostOptions): McpAppHost {
  let initialized = false;
  let disposed = false;
  let toolCall:
    | { readonly arguments: unknown; readonly result: McpAppCallToolResult | undefined }
    | undefined;
  let toolCallSent = false;
  let pending = 0;
  let sentContext: McpAppHostContext | undefined;
  let appDisplayModes: ReadonlyArray<string> | undefined;
  let nextHostRequestId = 0;
  const hostRequests = new Map<string, () => void>();

  const post = (message: unknown) => {
    if (!disposed) options.post(message);
  };
  const notify = (method: string, params: unknown) => post({ jsonrpc: '2.0', method, params });
  const respond = (id: JsonRpcId, result: unknown) => post({ jsonrpc: '2.0', id, result });
  const fail = (id: JsonRpcId, code: number, message: string) =>
    post({ jsonrpc: '2.0', id, error: { code, message } });

  const sendToolCall = () => {
    if (!initialized || toolCall === undefined || toolCallSent) return;
    toolCallSent = true;
    notify('ui/notifications/tool-input', {
      arguments: isObject(toolCall.arguments) ? toolCall.arguments : {},
    });
    if (toolCall.result !== undefined) {
      notify('ui/notifications/tool-result', normalizeMcpAppToolResult(toolCall.result));
    }
  };

  const answer = (id: JsonRpcId, run: () => Promise<unknown>) => {
    if (pending >= MAX_PENDING_REQUESTS) {
      fail(id, -32000, 'Too many requests in flight.');
      return;
    }
    pending += 1;
    void run().then(
      (result) => {
        pending -= 1;
        respond(id, result);
      },
      (error: unknown) => {
        pending -= 1;
        fail(id, -32000, errorMessage(error));
      }
    );
  };

  const callTool = async (name: string, args: Record<string, unknown>) => {
    // Görünürlük ve salt okunurluk sunucunun araç tanımından okunur; uygulamanın beyanına
    // güvenilmez.
    const info = await options.toolInfo(name);
    if (!info.callable) throw new McpAppHostRefusal('This app cannot call that tool.');
    if (!info.readOnly) {
      const approved = await options.confirm({
        kind: 'tool',
        server: options.app.server,
        tool: name,
        ...(info.title !== undefined ? { title: info.title } : {}),
        arguments: args,
      });
      if (approved !== true) throw new McpAppHostRefusal('Declined by the user.');
    }
    return normalizeMcpAppToolResult(await options.callTool({ name, arguments: args }));
  };

  const sendMessage = async (text: string) => {
    const send = options.sendMessage;
    if (send === undefined) throw new McpAppHostRefusal('Messages are not available here.');
    const approved = await options.confirm({ kind: 'message', server: options.app.server, text });
    if (approved !== true) throw new McpAppHostRefusal('Declined by the user.');
    await send(text);
  };

  const handleRequest = (id: JsonRpcId, method: string, params: Record<string, unknown>) => {
    // Başlatma tamamlanmadan yalnızca `ui/initialize` ve `ping` yanıtlanır.
    if (
      !initialized &&
      method !== 'ui/initialize' &&
      method !== 'ping' &&
      sentContext === undefined
    ) {
      fail(id, -32002, 'The app has not initialized yet.');
      return;
    }
    switch (method) {
      case 'ui/initialize': {
        const requested = params.protocolVersion;
        const declared = isObject(params.appCapabilities)
          ? params.appCapabilities.availableDisplayModes
          : undefined;
        appDisplayModes = Array.isArray(declared)
          ? declared.filter((mode): mode is string => typeof mode === 'string')
          : undefined;
        sentContext = options.hostContext();
        respond(id, {
          protocolVersion:
            requested === MCP_APP_PROTOCOL_VERSION ? requested : MCP_APP_PROTOCOL_VERSION,
          hostInfo: { name: options.hostName, version: options.hostVersion },
          hostCapabilities: {
            openLinks: {},
            serverTools: {},
            serverResources: {},
            logging: {},
            ...(options.sendMessage !== undefined ? { message: { text: {} } } : {}),
            sandbox: {
              ...(options.app.csp === undefined ? {} : { csp: options.app.csp }),
              ...(options.app.permissions === undefined
                ? {}
                : { permissions: options.app.permissions }),
            },
          },
          hostContext: sentContext,
        });
        return;
      }
      case 'ping':
        respond(id, {});
        return;
      case 'tools/call': {
        const name = params.name;
        const args = params.arguments ?? {};
        if (typeof name !== 'string' || name.trim() === '' || !isObject(args)) {
          fail(id, -32602, 'tools/call needs a tool name and object arguments.');
          return;
        }
        answer(id, () => callTool(name, args));
        return;
      }
      case 'resources/read': {
        const uri = params.uri;
        if (typeof uri !== 'string' || uri.trim() === '') {
          fail(id, -32602, 'resources/read needs a uri.');
          return;
        }
        answer(id, () => options.readResource({ uri }));
        return;
      }
      case 'ui/open-link': {
        const url = params.url;
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
          fail(id, -32602, 'Only http(s) links can be opened.');
          return;
        }
        answer(id, () => options.openLink(url).then(() => ({})));
        return;
      }
      case 'ui/message': {
        // SDK içerik bloğu dizisi gönderir; spesifikasyon metni tek blok gösterir.
        const blocks = Array.isArray(params.content) ? params.content : [params.content];
        const texts = blocks.map((block) =>
          isObject(block) && block.type === 'text' && typeof block.text === 'string'
            ? block.text
            : undefined
        );
        if (params.role !== 'user' || texts.length === 0 || texts.includes(undefined)) {
          fail(id, -32602, 'Only text messages from the user role are supported.');
          return;
        }
        const text = texts.join('\n').trim();
        if (text === '') {
          fail(id, -32602, 'ui/message needs non-empty text.');
          return;
        }
        answer(id, () => sendMessage(text).then(() => ({})));
        return;
      }
      case 'ui/request-display-mode': {
        const current = options.hostContext().displayMode;
        const mode = params.mode;
        // Ana makinenin ya da uygulamanın desteklemediği kip mevcut kipi korur.
        const allowed =
          typeof mode === 'string' &&
          options.hostContext().availableDisplayModes.includes(mode as McpAppDisplayMode) &&
          (appDisplayModes === undefined || appDisplayModes.includes(mode));
        if (!allowed || mode === current) {
          respond(id, { mode: current });
          return;
        }
        answer(id, () =>
          options.requestDisplayMode(mode as McpAppDisplayMode).then((result) => ({ mode: result }))
        );
        return;
      }
      default:
        fail(id, -32601, `Method not found: ${method}`);
    }
  };

  const handleNotification = (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case 'ui/notifications/initialized': {
        if (initialized || sentContext === undefined) return;
        initialized = true;
        sendToolCall();
        hostHandle.updateHostContext();
        return;
      }
      case 'ui/notifications/size-changed': {
        const width = typeof params.width === 'number' ? params.width : undefined;
        const height = typeof params.height === 'number' ? params.height : undefined;
        if (width !== undefined || height !== undefined) {
          options.onSizeChanged({
            ...(width === undefined ? {} : { width }),
            ...(height === undefined ? {} : { height }),
          });
        }
        return;
      }
      case 'ui/notifications/request-teardown':
        options.onRequestTeardown();
        return;
      default:
    }
  };

  const handleResponse = (id: JsonRpcId) => {
    const settle = hostRequests.get(String(id));
    if (settle === undefined) return;
    hostRequests.delete(String(id));
    settle();
  };

  const hostHandle: McpAppHost = {
    receive: (data) => {
      if (disposed || !isObject(data) || data.jsonrpc !== '2.0') return;
      const requestId = isId(data.id) && typeof data.method === 'string' ? data.id : undefined;
      const json = stringifyJson(data);
      if (json === undefined) {
        if (requestId !== undefined) fail(requestId, -32602, 'Params must be JSON.');
        return;
      }
      if (encoder.encode(json).byteLength > MAX_MESSAGE_BYTES) {
        if (requestId !== undefined) fail(requestId, -32600, 'Message too large.');
        return;
      }
      const method = data.method;
      if (typeof method !== 'string') {
        if (isId(data.id) && ('result' in data || 'error' in data)) handleResponse(data.id);
        return;
      }
      // postMessage `undefined` değerlerini korur; JSON biçimiyle devam edilir.
      const { params: jsonParams }: { params?: unknown } = JSON.parse(json) as {
        params?: unknown;
      };
      const params = isObject(jsonParams) ? jsonParams : {};
      if (isId(data.id)) handleRequest(data.id, method, params);
      else handleNotification(method, params);
    },
    setToolCall: (call) => {
      // Çalışan çağrının sonucu yoktur; yalnızca tamamlanması onun yerini alabilir.
      if (toolCall === undefined || !toolCallSent) {
        if (toolCall?.result === undefined) toolCall = call;
        sendToolCall();
        return;
      }
      if (toolCall.result !== undefined || call.result === undefined) return;
      toolCall = { arguments: toolCall.arguments, result: call.result };
      notify('ui/notifications/tool-result', normalizeMcpAppToolResult(call.result));
    },
    updateHostContext: () => {
      // Spesifikasyon başlatma bitmeden mesaj gönderilmesini yasaklar.
      if (!initialized || sentContext === undefined) return;
      const next = options.hostContext();
      const changes: Record<string, unknown> = {};
      for (const key of Object.keys(next) as Array<keyof McpAppHostContext>) {
        if (JSON.stringify(next[key]) !== JSON.stringify(sentContext[key])) {
          changes[key] = next[key];
        }
      }
      sentContext = next;
      if (Object.keys(changes).length > 0) {
        notify('ui/notifications/host-context-changed', changes);
      }
    },
    teardown: () =>
      new Promise<void>((resolve) => {
        const pendingTimer: { current?: ReturnType<typeof setTimeout> } = {};
        const finish = () => {
          clearTimeout(pendingTimer.current);
          disposed = true;
          resolve();
        };
        if (disposed || !initialized) {
          finish();
          return;
        }
        const id = `orkestra-host-${nextHostRequestId++}`;
        hostRequests.set(id, finish);
        pendingTimer.current = setTimeout(() => {
          hostRequests.delete(id);
          finish();
        }, TEARDOWN_TIMEOUT_MS);
        post({ jsonrpc: '2.0', id, method: 'ui/resource-teardown', params: {} });
      }),
    dispose: () => {
      disposed = true;
    },
  };
  return hostHandle;
}

/**
 * Ana makine temasından MCP Apps stil değişkenlerine eşleme. Değerler çağıran tarafından renk
 * desenine göre süzülmüş olmalıdır.
 */
export const MCP_APP_STYLE_VARIABLES = [
  '--color-background-primary',
  '--color-background-secondary',
  '--color-background-tertiary',
  '--color-text-primary',
  '--color-text-secondary',
  '--color-text-tertiary',
  '--color-border-primary',
  '--color-border-secondary',
  '--color-ring-primary',
  '--color-text-info',
] as const;
