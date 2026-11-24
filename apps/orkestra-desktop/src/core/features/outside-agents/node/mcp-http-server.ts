// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/mcp/McpHttpServer.ts
// (Bearer doğrulaması, tarayıcı Origin reddi, oturum kimliği, okuma/eylem denetimi). Effect ve
// bulut aktarımı (T3 Connect, OAuth) yok: yalnızca loopback, durumsuz JSON yanıtlı akışlı HTTP.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@orkestra/shared/logger';
import { z } from 'zod';
import type { OutsideAgentAccess } from '@core/features/outside-agents/api/contract';
import { OUTSIDE_AGENTS_MCP_PATH } from '@core/features/outside-agents/api/contract';
import type { OutsideAgentPrincipal } from './client-registry';
import type { OutsideAgentBackend } from './outside-agent-backend';
import {
  describeOutsideTool,
  OUTSIDE_AGENT_TOOLS,
  OUTSIDE_AGENTS_INSTRUCTIONS,
  OutsideToolError,
  type OutsideAgentTool,
} from './outside-agent-tools';

/**
 * Dış ajanlar için MCP sunucusu (Streamable HTTP taşıması, yalnızca JSON yanıtları).
 *
 * Güvenlik:
 * - Yalnızca 127.0.0.1'e bağlanır; `Host` başlığı loopback olmalıdır (DNS rebinding'e karşı).
 * - `Origin` başlığı taşıyan her istek (tarayıcı) kimlik denetiminden önce reddedilir.
 * - Her istek istemciye özel Bearer belirteci taşır; belirteç asla loglanmaz.
 * - Her araç çağrısında istemcinin GÜNCEL yetkisi okunur: iptal ve yetki düşürme anında geçerlidir.
 * - Başarısız kimlik denemeleri sınırlanır.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
const LATEST_PROTOCOL_VERSION = '2025-06-18';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SESSIONS = 256;
const TOOL_TIMEOUT_MS = 180_000;
const AUTH_FAILURE_WINDOW_MS = 60_000;
const AUTH_FAILURE_LIMIT = 20;
const AUTH_LOCKOUT_MS = 30_000;
const SESSION_HEADER = 'mcp-session-id';

export type OutsideAgentsMcpServerOptions = {
  port: number;
  /** Testler için; üretimde her zaman 127.0.0.1. */
  host?: '127.0.0.1';
  authenticate(token: string): Promise<OutsideAgentPrincipal | null>;
  /** İstemcinin şu anki yetkisi; iptal edildiyse null. */
  currentAccess(clientId: string): OutsideAgentAccess | null;
  /** Masaüstü denetleyicileri hazır değilse null. */
  backend(): OutsideAgentBackend | null;
  onUsed?(clientId: string): void;
  logger: Logger;
  serverVersion: string;
  tools?: readonly OutsideAgentTool[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type OutsideAgentsMcpServer = {
  port: number;
  url: string;
  /** İstemcinin açık MCP oturumlarını düşürür (iptal sonrası). */
  closeClientSessions(clientId: string): void;
  close(): Promise<void>;
};

type JsonRpcId = string | number;
type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId | null; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId | null; error: { code: number; message: string } };

const jsonRpcMessageSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});

const toolCallParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function startOutsideAgentsMcpServer(
  options: OutsideAgentsMcpServerOptions
): Promise<OutsideAgentsMcpServer> {
  const tools = options.tools ?? OUTSIDE_AGENT_TOOLS;
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const now = options.now ?? Date.now;
  /** Oturum kimliği → istemci kimliği. */
  const sessions = new Map<string, string>();
  const authFailures: number[] = [];
  let lockedUntil = 0;
  let boundPort = options.port;

  const server = createServer((request, response) => {
    void serve(request, response).catch((error) => {
      if (error instanceof HttpFailure) {
        respondJson(response, error.status, rpcError(null, -32600, error.message));
        return;
      }
      options.logger.warn('Outside agents MCP request failed', { error: String(error) });
      respondJson(response, 500, rpcError(null, -32603, 'Internal error'));
    });
  });

  function allowedHost(header: string | undefined): boolean {
    if (!header) return false;
    const allowed = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
    return allowed.includes(header.toLowerCase());
  }

  function recordAuthFailure(): void {
    const time = now();
    authFailures.push(time);
    while (authFailures.length > 0 && authFailures[0]! < time - AUTH_FAILURE_WINDOW_MS) {
      authFailures.shift();
    }
    if (authFailures.length >= AUTH_FAILURE_LIMIT) {
      lockedUntil = time + AUTH_LOCKOUT_MS;
      authFailures.length = 0;
    }
  }

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '').split('?', 1)[0];
    if (path !== OUTSIDE_AGENTS_MCP_PATH) {
      respondJson(response, 404, rpcError(null, -32600, 'Not found'));
      return;
    }
    // Tarayıcılar her zaman Origin gönderir; MCP istemcileri göndermez. Kimlikten önce reddet.
    if (request.headers.origin !== undefined) {
      respondJson(response, 403, rpcError(null, -32600, 'Browser requests are not allowed'));
      return;
    }
    if (!allowedHost(request.headers.host)) {
      respondJson(response, 403, rpcError(null, -32600, 'Invalid Host header'));
      return;
    }
    if (now() < lockedUntil) {
      response.setHeader('retry-after', String(Math.ceil((lockedUntil - now()) / 1000)));
      respondJson(response, 429, rpcError(null, -32600, 'Too many failed sign-in attempts'));
      return;
    }
    const authorization = request.headers.authorization ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] ?? '';
    const principal = token ? await options.authenticate(token) : null;
    if (!principal) {
      recordAuthFailure();
      response.setHeader('www-authenticate', 'Bearer realm="orkestra"');
      respondJson(
        response,
        401,
        rpcError(
          null,
          -32001,
          'Missing or invalid Orkestra MCP token. Create one in Orkestra settings.'
        )
      );
      return;
    }

    if (request.method === 'GET') {
      // Sunucu kaynaklı SSE akışı sunulmaz (araç listesi değişmez, bildirim yok).
      response.setHeader('allow', 'POST, DELETE');
      respondJson(response, 405, rpcError(null, -32600, 'Method not allowed'));
      return;
    }
    const sessionId = headerValue(request.headers[SESSION_HEADER]);
    if (request.method === 'DELETE') {
      if (sessionId && sessions.get(sessionId) === principal.clientId) sessions.delete(sessionId);
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST, DELETE');
      respondJson(response, 405, rpcError(null, -32600, 'Method not allowed'));
      return;
    }

    const body = await readBody(request);
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      respondJson(response, 400, rpcError(null, -32700, 'Parse error'));
      return;
    }
    if (Array.isArray(parsedBody)) {
      respondJson(response, 400, rpcError(null, -32600, 'Batch requests are not supported'));
      return;
    }
    const message = jsonRpcMessageSchema.safeParse(parsedBody);
    if (!message.success) {
      respondJson(response, 400, rpcError(null, -32600, 'Invalid JSON-RPC message'));
      return;
    }
    const { id, method, params } = message.data;
    // Bildirimler ve yanıtlar: kabul edildi, gövde yok.
    if (id === undefined || id === null || method === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    if (method !== 'initialize' && sessionId !== undefined) {
      // Bilinmeyen/başka istemciye ait oturum: istemci yeniden başlatmalı (MCP oturum kuralı).
      if (sessions.get(sessionId) !== principal.clientId) {
        respondJson(response, 404, rpcError(id, -32001, 'Session not found; initialize again'));
        return;
      }
    }
    options.onUsed?.(principal.clientId);

    if (method === 'initialize') {
      const newSession = randomBytes(24).toString('base64url');
      sessions.set(newSession, principal.clientId);
      while (sessions.size > MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
      response.setHeader('mcp-session-id', newSession);
      respondJson(response, 200, { jsonrpc: '2.0', id, result: initializeResult(params) });
      return;
    }
    respondJson(response, 200, await dispatch(principal, id, method, params));
  }

  function initializeResult(params: unknown) {
    const requested =
      params && typeof params === 'object'
        ? (params as { protocolVersion?: unknown }).protocolVersion
        : undefined;
    const protocolVersion =
      typeof requested === 'string' &&
      (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'orkestra', title: 'Orkestra', version: options.serverVersion },
      instructions: OUTSIDE_AGENTS_INSTRUCTIONS,
    };
  }

  async function dispatch(
    principal: OutsideAgentPrincipal,
    id: JsonRpcId,
    method: string,
    params: unknown
  ): Promise<JsonRpcResponse> {
    switch (method) {
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: tools.map((tool) => describeOutsideTool(tool)) },
        };
      case 'tools/call': {
        const parsed = toolCallParamsSchema.safeParse(params);
        if (!parsed.success) return rpcError(id, -32602, 'Invalid tools/call params');
        return { jsonrpc: '2.0', id, result: await callTool(principal, parsed.data) };
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  async function callTool(
    principal: OutsideAgentPrincipal,
    call: { name: string; arguments?: Record<string, unknown> }
  ) {
    const tool = toolsByName.get(call.name);
    if (!tool) return toolFailure(`Unknown tool '${call.name}'.`);
    // Yetki her çağrıda güncel kayıttan okunur (iptal/düşürme anında geçerli).
    const access = options.currentAccess(principal.clientId);
    if (access === null) return toolFailure('This client was revoked in Orkestra.');
    if (tool.requires === 'act' && access !== 'act') {
      return toolFailure(
        `${tool.name} changes things in Orkestra, and this client was approved for read-only access. Ask the user to give it the "act" permission in Orkestra settings.`
      );
    }
    const args = tool.input.safeParse(call.arguments ?? {});
    if (!args.success) {
      return toolFailure(`Invalid arguments for ${tool.name}: ${z.prettifyError(args.error)}`);
    }
    const backend = options.backend();
    if (!backend) return toolFailure('Orkestra is still starting; try again in a moment.');
    try {
      const result = await withTimeout(
        tool.run(
          {
            backend,
            access,
            clientName: principal.name,
            ...(options.sleep ? { sleep: options.sleep } : {}),
            ...(options.now ? { now: options.now } : {}),
          },
          args.data as never
        ),
        TOOL_TIMEOUT_MS
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: false,
      };
    } catch (error) {
      if (error instanceof OutsideToolError) return toolFailure(error.message);
      options.logger.warn('Outside agents MCP tool failed', {
        tool: tool.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return toolFailure(
        `Orkestra could not complete ${tool.name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      server.requestTimeout = TOOL_TIMEOUT_MS + 30_000;
      server.headersTimeout = 30_000;
      boundPort = (server.address() as AddressInfo).port;
      resolve({
        port: boundPort,
        url: `http://127.0.0.1:${boundPort}${OUTSIDE_AGENTS_MCP_PATH}`,
        closeClientSessions(clientId) {
          for (const [session, owner] of sessions) {
            if (owner === clientId) sessions.delete(session);
          }
        },
        close: () =>
          new Promise<void>((done) => {
            sessions.clear();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function toolFailure(text: string) {
  return { content: [{ type: 'text', text }], isError: true };
}

function rpcError(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The operation timed out.')), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpFailure(413, 'Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}
