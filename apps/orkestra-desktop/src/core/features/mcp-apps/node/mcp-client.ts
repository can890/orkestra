import { spawn, type ChildProcess } from 'node:child_process';
import { MCP_APP_EXTENSION_ID, MCP_APP_MIME_TYPE } from '@orkestra/core/runtimes/acp/api/client';

/**
 * Bağımlılıksız, en küçük MCP istemcisi: MCP uygulamalarının kaynağını okumak ve uygulamanın kendi
 * sunucusundaki araçları çağırmak için yeterli olan `initialize`, `tools/list`, `tools/call` ve
 * `resources/read`. İki taşıma desteklenir: stdio (satır başına bir JSON-RPC mesajı) ve Streamable
 * HTTP. Sunucunun istemciye gönderdiği istekler (sampling, roots, elicitation) desteklenmez ve
 * `-32601` ile reddedilir; `ping` yanıtlanır.
 */

export const MCP_CLIENT_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_HTTP_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_PAGES = 20;

type JsonRpcId = string | number;
export type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export interface McpTransport {
  start(onMessage: (message: JsonRpcMessage) => void, onClose: (error?: Error) => void): void;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isJsonRpc(value: unknown): value is JsonRpcMessage {
  return isObject(value) && value.jsonrpc === '2.0';
}

export type StdioServerSpec = {
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
};

/**
 * Sunucuyu argv ile (kabuk olmadan) başlatır. Ortam, ajanların sunucuyu başlatırken kullandığı
 * gibi süreç ortamı + sunucu tanımındaki `env`'dir. stderr okunur ve atılır.
 */
export class StdioMcpTransport implements McpTransport {
  private child: ChildProcess | undefined;
  private closed = false;

  constructor(
    private readonly spec: StdioServerSpec,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env
  ) {}

  start(onMessage: (message: JsonRpcMessage) => void, onClose: (error?: Error) => void): void {
    const child = spawn(this.spec.command, [...(this.spec.args ?? [])], {
      cwd: this.spec.cwd,
      env: { ...this.baseEnv, ...this.spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    this.child = child;
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        buffer = '';
        void this.close();
        onClose(new Error('MCP server sent an oversized message.'));
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isJsonRpc(parsed)) onMessage(parsed);
        } catch {
          // Sunucunun stdout'a yazdığı JSON olmayan satırlar yok sayılır.
        }
      }
    });
    child.stderr?.on('data', () => undefined);
    child.on('error', (error) => {
      this.closed = true;
      onClose(error);
    });
    child.on('exit', (code, signal) => {
      this.closed = true;
      onClose(new Error(`MCP server exited (${signal ?? code ?? 'unknown'}).`));
    });
    child.stdin?.on('error', () => undefined);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (this.closed || !stdin || stdin.destroyed) throw new Error('MCP server is not running.');
    await new Promise<void>((resolve, reject) => {
      stdin.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || this.closed) return;
    this.closed = true;
    child.stdin?.end();
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    timer.unref?.();
  }
}

export type HttpServerSpec = {
  url: string;
  headers?: Readonly<Record<string, string>>;
};

type FetchLike = typeof fetch;

/**
 * Streamable HTTP taşıması: her mesaj ayrı bir POST'tur; yanıt JSON ya da SSE olabilir. Sunucunun
 * verdiği `Mcp-Session-Id` sonraki isteklere eklenir. Eski SSE taşıması desteklenmez.
 */
export class HttpMcpTransport implements McpTransport {
  private sessionId: string | undefined;
  private onMessage: ((message: JsonRpcMessage) => void) | undefined;
  private closed = false;
  private readonly controllers = new Set<AbortController>();

  constructor(
    private readonly spec: HttpServerSpec,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  start(onMessage: (message: JsonRpcMessage) => void): void {
    this.onMessage = onMessage;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error('MCP connection is closed.');
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const response = await this.fetchImpl(this.spec.url, {
        method: 'POST',
        headers: {
          ...this.spec.headers,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': MCP_CLIENT_PROTOCOL_VERSION,
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const session = response.headers.get('mcp-session-id');
      if (session) this.sessionId = session;
      if (response.status === 202 || response.status === 204) return;
      if (!response.ok) {
        throw new Error(
          response.status === 401 || response.status === 403
            ? 'The MCP server needs sign-in that Orkestra does not have.'
            : `MCP server answered HTTP ${response.status}.`
        );
      }
      const body = await readLimited(response);
      const type = response.headers.get('content-type') ?? '';
      if (type.includes('text/event-stream')) {
        for (const data of parseSse(body)) this.deliver(data);
      } else if (body.trim()) {
        this.deliver(body);
      }
    } finally {
      this.controllers.delete(controller);
    }
  }

  private deliver(text: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (isJsonRpc(item)) this.onMessage?.(item);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    if (!this.sessionId) return;
    try {
      await this.fetchImpl(this.spec.url, {
        method: 'DELETE',
        headers: { ...this.spec.headers, 'mcp-session-id': this.sessionId },
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      // Oturum kapatma en iyi çabadır.
    }
  }
}

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HTTP_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('MCP server response is too large.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** SSE gövdesindeki `data:` olaylarını döndürür. */
export function parseSse(body: string): string[] {
  const events: string[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (data.length > 0) events.push(data.join('\n'));
  }
  return events;
}

export type McpToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

export class McpRequestError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message);
    this.name = 'McpRequestError';
  }
}

export type McpClientOptions = {
  clientInfo: { name: string; version: string };
  requestTimeoutMs?: number;
};

export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private closedError: Error | undefined;
  serverCapabilities: Record<string, unknown> = {};

  constructor(
    private readonly transport: McpTransport,
    private readonly options: McpClientOptions
  ) {}

  get isClosed(): boolean {
    return this.closedError !== undefined;
  }

  async connect(): Promise<void> {
    this.transport.start(
      (message) => this.handle(message),
      (error) => this.fail(error ?? new Error('MCP connection closed.'))
    );
    const result = await this.request('initialize', {
      protocolVersion: MCP_CLIENT_PROTOCOL_VERSION,
      capabilities: {
        // MCP Apps eklentisi: bazı sunucular UI kaynaklarını yalnızca destekleyen istemcilere sunar.
        extensions: { [MCP_APP_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
      },
      clientInfo: this.options.clientInfo,
    });
    this.serverCapabilities =
      isObject(result) && isObject(result.capabilities) ? result.capabilities : {};
    await this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      if (!isObject(result)) break;
      for (const tool of Array.isArray(result.tools) ? result.tools : []) {
        if (isObject(tool) && typeof tool.name === 'string') tools.push(tool as McpToolDefinition);
      }
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args });
  }

  readResource(uri: string): Promise<unknown> {
    return this.request('resources/read', { uri });
  }

  async close(): Promise<void> {
    this.fail(new Error('MCP connection closed.'));
    await this.transport.close();
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpRequestError(`MCP request ${method} timed out.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.transport
        .send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
        .catch((error: unknown) => {
          const entry = this.pending.get(id);
          if (!entry) return;
          clearTimeout(entry.timer);
          this.pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    await this.transport.send({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  private handle(message: JsonRpcMessage) {
    if (typeof message.method === 'string') {
      // Sunucudan gelen istek: yalnızca ping desteklenir.
      if (message.id !== undefined && message.id !== null) {
        const reply: JsonRpcMessage =
          message.method === 'ping'
            ? { jsonrpc: '2.0', id: message.id, result: {} }
            : {
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32601, message: `Method not supported: ${message.method}` },
              };
        void this.transport.send(reply).catch(() => undefined);
      }
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    if (message.error) {
      entry.reject(
        new McpRequestError(message.error.message || 'MCP request failed.', message.error.code)
      );
    } else {
      entry.resolve(message.result);
    }
  }

  private fail(error: Error) {
    if (!this.closedError) this.closedError = error;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }
}
