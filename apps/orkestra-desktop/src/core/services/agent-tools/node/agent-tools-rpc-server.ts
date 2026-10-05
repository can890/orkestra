import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@orkestra/shared/logger';
import { AGENT_TOOLS_SERVER_HEADER } from './agent-tools-bridge';

export type AgentToolsRpcServer = {
  url: string;
  port: number;
  close(): Promise<void>;
};

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Yalnızca 127.0.0.1'e bağlanan RPC uç noktası. Her istek bir konuşmaya özel Bearer belirteci
 * taşımalıdır; belirteç yalnızca o konuşmanın MCP köprüsüne ortam değişkeniyle verilir. Köprü
 * bağlandığı araç sunucusunu başlıkla bildirebilir; doğrulama bu bildirimi de hesaba katar.
 */
export function startAgentToolsRpcServer<Principal>(options: {
  authenticate(token: string, claimedServer: string | null): Principal | null;
  handle(principal: Principal, method: string, params: Record<string, unknown>): Promise<unknown>;
  logger: Logger;
}): Promise<AgentToolsRpcServer> {
  const server = createServer((request, response) => {
    void serve(request, response).catch((error) => {
      options.logger.warn('Orkestra ajan araçları: RPC isteği başarısız', {
        error: String(error),
      });
      respond(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/rpc') {
      respond(response, 404, { error: 'Not found' });
      return;
    }
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const claim = request.headers[AGENT_TOOLS_SERVER_HEADER];
    const claimedServer = typeof claim === 'string' && claim.trim() ? claim.trim() : null;
    const principal = token ? options.authenticate(token, claimedServer) : null;
    if (principal === null) {
      respond(response, 403, { error: 'Forbidden' });
      return;
    }
    const body = await readBody(request);
    const parsed = JSON.parse(body) as { method?: unknown; params?: unknown };
    if (typeof parsed.method !== 'string') {
      respond(response, 400, { error: 'method is required' });
      return;
    }
    const params =
      parsed.params && typeof parsed.params === 'object'
        ? (parsed.params as Record<string, unknown>)
        : {};
    respond(response, 200, await options.handle(principal, parsed.method, params));
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      // Uzun bekleme çağrıları için Node'un varsayılan istek zaman aşımlarını kapat.
      server.requestTimeout = 0;
      server.headersTimeout = 60_000;
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/rpc`,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function respond(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent) return;
  const body = JSON.stringify(payload ?? null);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}
