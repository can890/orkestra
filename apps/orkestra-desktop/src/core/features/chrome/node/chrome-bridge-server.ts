import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

// Masaüstü ↔ Chrome uzantısı köprüsünün taşıma katmanı. Yalnızca 127.0.0.1'e bağlanır; el
// sıkışmada Origin (chrome-extension://), Host ve eşleştirme belirteci doğrulanır; aynı anda tek
// uzantı bağlantısı vardır. Belirteç hiçbir günlüğe, hataya ya da yanıta girmez.

/** Uzantıyla paylaşılan alt protokol adı ve belirteç öneki (apps/chrome-extension/lib/policy.js). */
export const CHROME_BRIDGE_SUBPROTOCOL = 'orkestra-chrome.v1';
export const CHROME_BRIDGE_TOKEN_PREFIX = 'token.';
export const CHROME_BRIDGE_PROTOCOL_VERSION = 1;
export const CHROME_BRIDGE_HOST = '127.0.0.1';

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-z]{32}$/;
const MAX_PAYLOAD_BYTES = 12 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 16;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 15_000;

export type ChromeBridgeErrorCode =
  | 'not_connected'
  | 'timeout'
  | 'connection_closed'
  | 'busy'
  | (string & {});

export class ChromeBridgeError extends Error {
  constructor(
    readonly code: ChromeBridgeErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ChromeBridgeError';
  }
}

type BridgeLogger = {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
};

export type ChromeBridgeServerOptions = {
  /** Güncel eşleştirme belirteci; eşleştirme yoksa null (bağlantılar reddedilir). */
  getToken(): string | null;
  logger: BridgeLogger;
  onConnectionChange?(connected: boolean): void;
  requestTimeoutMs?: number;
  heartbeatMs?: number;
};

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export class ChromeBridgeServer {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private current: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private alive = false;
  private counter = 0;
  private readonly pending = new Map<string, Pending>();
  private boundPort: number | null = null;

  constructor(private readonly options: ChromeBridgeServerOptions) {}

  get port(): number | null {
    return this.boundPort;
  }

  get listening(): boolean {
    return this.server !== null && this.boundPort !== null;
  }

  get connected(): boolean {
    return this.current !== null && this.current.readyState === WebSocket.OPEN;
  }

  /** 127.0.0.1 üzerinde dinlemeye başlar; port 0 ise işletim sistemi seçer. */
  async listen(port: number): Promise<number> {
    if (this.server) throw new Error('The Chrome bridge is already listening.');
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_PAYLOAD_BYTES,
      handleProtocols: (protocols) =>
        protocols.has(CHROME_BRIDGE_SUBPROTOCOL) ? CHROME_BRIDGE_SUBPROTOCOL : false,
    });
    const server = createServer((_request, response) => {
      response.writeHead(426, { 'Content-Length': '0', Connection: 'close' });
      response.end();
    });
    server.on('upgrade', (request, socket, head) => this.onUpgrade(request, socket, head));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen({ port, host: CHROME_BRIDGE_HOST, exclusive: true }, () => {
        server.off('error', onError);
        resolve();
      });
    });
    this.server = server;
    this.wss = wss;
    this.boundPort = (server.address() as AddressInfo).port;
    return this.boundPort;
  }

  /** Dinlemeyi ve uzantı bağlantısını kapatır. */
  async close(): Promise<void> {
    this.disconnect();
    const server = this.server;
    const wss = this.wss;
    this.server = null;
    this.wss = null;
    this.boundPort = null;
    wss?.close();
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }

  /** Bağlı uzantıyı keser (bekleyen istekler `connection_closed` ile biter). */
  disconnect(): void {
    const socket = this.current;
    if (socket) socket.close(1000, 'disconnected');
    this.teardownConnection(socket);
  }

  /** Uzantıdan bir eylem ister; uzantı hata dönerse `ChromeBridgeError` fırlatır. */
  request(
    action: string,
    params: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    const socket = this.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new ChromeBridgeError('not_connected', 'The Chrome extension is not connected.')
      );
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new ChromeBridgeError('busy', 'Too many pending Chrome requests.'));
    }
    const id = `r${++this.counter}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ChromeBridgeError('timeout', `The Chrome extension did not answer ${action}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: 'request', id, action, params }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ChromeBridgeError('connection_closed', 'The request could not be sent.'));
      });
    });
  }

  private onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refusal = this.checkHandshake(request);
    if (refusal) {
      this.options.logger.warn('Chrome köprüsü: bağlantı reddedildi', { reason: refusal.reason });
      socket.end(
        `HTTP/1.1 ${refusal.status} ${refusal.text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
      );
      return;
    }
    const wss = this.wss;
    if (!wss) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
  }

  private checkHandshake(
    request: IncomingMessage
  ): { status: number; text: string; reason: string } | null {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !EXTENSION_ORIGIN.test(origin)) {
      return { status: 403, text: 'Forbidden', reason: 'origin' };
    }
    const host = request.headers.host ?? '';
    const port = this.boundPort;
    if (port === null || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) {
      return { status: 403, text: 'Forbidden', reason: 'host' };
    }
    const expected = this.options.getToken();
    if (!expected) return { status: 403, text: 'Forbidden', reason: 'not-paired' };
    const header = request.headers['sec-websocket-protocol'];
    const protocols = (typeof header === 'string' ? header : '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const tokens = protocols.filter((value) => value.startsWith(CHROME_BRIDGE_TOKEN_PREFIX));
    if (!protocols.includes(CHROME_BRIDGE_SUBPROTOCOL) || tokens.length !== 1) {
      return { status: 403, text: 'Forbidden', reason: 'protocol' };
    }
    const presented = tokens[0]!.slice(CHROME_BRIDGE_TOKEN_PREFIX.length);
    if (!constantTimeEqual(presented, expected)) {
      return { status: 401, text: 'Unauthorized', reason: 'token' };
    }
    if (this.current) return { status: 409, text: 'Conflict', reason: 'already-connected' };
    return null;
  }

  private accept(ws: WebSocket): void {
    if (this.current) {
      // Yarış: iki geçerli el sıkışma aynı anda geldi; ikincisi reddedilir.
      ws.close(1013, 'already connected');
      return;
    }
    this.current = ws;
    this.alive = true;
    ws.on('message', (data, isBinary) => this.onMessage(ws, data, isBinary));
    ws.on('close', () => this.teardownConnection(ws));
    ws.on('error', () => this.teardownConnection(ws));
    this.heartbeat = setInterval(() => {
      if (!this.alive) {
        ws.terminate();
        return;
      }
      this.alive = false;
      ws.send(JSON.stringify({ type: 'ping' }));
    }, this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    this.heartbeat.unref();
    ws.send(JSON.stringify({ type: 'welcome', version: CHROME_BRIDGE_PROTOCOL_VERSION }));
    this.options.logger.info('Chrome uzantısı bağlandı');
    this.options.onConnectionChange?.(true);
  }

  private teardownConnection(ws: WebSocket | null): void {
    if (!ws || this.current !== ws) return;
    this.current = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new ChromeBridgeError('connection_closed', 'The Chrome extension disconnected.')
      );
      this.pending.delete(id);
    }
    this.options.logger.info('Chrome uzantısı bağlantısı kapandı');
    this.options.onConnectionChange?.(false);
  }

  private onMessage(ws: WebSocket, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      ws.close(1003, 'text only');
      return;
    }
    this.alive = true;
    let message: unknown;
    try {
      message = JSON.parse(rawToString(data));
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (message.type !== 'response' || typeof message.id !== 'string') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === true) {
      pending.resolve(message.result);
      return;
    }
    const error = isRecord(message.error) ? message.error : {};
    pending.reject(
      new ChromeBridgeError(
        typeof error.code === 'string' ? error.code : 'failed',
        typeof error.message === 'string'
          ? error.message
          : 'The Chrome extension reported an error.'
      )
    );
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
