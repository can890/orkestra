import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { secret } from '@orkestra/shared';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';

export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
const SECRET_KEY_PREFIX = 'automation.webhookSecret.';

export type AutomationWebhookInfo = {
  url: string;
  hasSecret: boolean;
  secretPreview: string;
  curlSnippet: string;
};

export type AutomationWebhookServerDeps = {
  secrets: SecretStore;
  triggerAutomation: (params: {
    automationId: string;
    payload: unknown;
  }) => Promise<{ ok: true; runId?: string } | { ok: false; status: number; error: string }>;
  logger?: {
    warn(message: string, context?: Record<string, unknown>): void;
  };
};

function secretKey(automationId: string): string {
  return `${SECRET_KEY_PREFIX}${automationId}`;
}

function previewSecret(token: string): string {
  if (token.length <= 8) return '••••••••';
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

function constantTimeTokenEquals(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readLimitedBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<{ ok: true; raw: string } | { ok: false; reason: 'too_large' | 'read_error' }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    let settled = false;

    const finish = (res: { ok: true; raw: string } | { ok: false; reason: 'too_large' | 'read_error' }) => {
      if (settled) return;
      settled = true;
      resolve(res);
    };

    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        if (total > maxBytes * 16) {
          finish({ ok: false, reason: 'too_large' });
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        finish({ ok: false, reason: 'too_large' });
      } else {
        finish({ ok: true, raw: Buffer.concat(chunks).toString('utf8') });
      }
    });
    req.on('error', () => finish({ ok: false, reason: 'read_error' }));
  });
}

export class AutomationWebhookServer {
  private server: Server | null = null;
  private boundPort: number | null = null;
  private startPromise: Promise<number> | null = null;

  constructor(private readonly deps: AutomationWebhookServerDeps) {}

  async ensureStarted(): Promise<number> {
    if (this.boundPort !== null) return this.boundPort;
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      server.on('error', (error) => {
        if (this.boundPort === null) {
          this.startPromise = null;
          reject(error);
        }
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          this.startPromise = null;
          reject(new Error('Webhook sunucusu loopback porta bağlanamadı'));
          return;
        }
        this.server = server;
        this.boundPort = address.port;
        resolve(address.port);
      });
    });

    return this.startPromise;
  }

  async dispose(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    this.startPromise = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async ensureSecret(automationId: string): Promise<string> {
    const key = secretKey(automationId);
    const existing = await this.deps.secrets.getSecret(key);
    if (existing) return existing.expose();
    const fresh = randomBytes(24).toString('hex');
    await this.deps.secrets.setSecret(key, secret(fresh, key));
    return fresh;
  }

  async rotateSecret(automationId: string): Promise<AutomationWebhookInfo> {
    const key = secretKey(automationId);
    const fresh = randomBytes(24).toString('hex');
    await this.deps.secrets.setSecret(key, secret(fresh, key));
    return this.buildInfo(automationId, fresh);
  }

  async getWebhookInfo(automationId: string): Promise<AutomationWebhookInfo> {
    const token = await this.ensureSecret(automationId);
    return this.buildInfo(automationId, token);
  }

  private async buildInfo(automationId: string, token: string): Promise<AutomationWebhookInfo> {
    const port = await this.ensureStarted();
    const url = `http://127.0.0.1:${port}/webhook/${encodeURIComponent(automationId)}`;
    return {
      url,
      hasSecret: true,
      secretPreview: previewSecret(token),
      curlSnippet: `curl -X POST "${url}" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '{"source":"webhook"}'`,
    };
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '/';
    const match = /^\/webhook\/([^/?#]+)\/?(?:\?.*)?$/.exec(rawUrl);
    if (method !== 'POST' || !match) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const automationId = decodeURIComponent(match[1]!);
    const key = secretKey(automationId);
    const expectedSecret = await this.deps.secrets.getSecret(key);
    if (!expectedSecret) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const authHeader = req.headers.authorization ?? '';
    const bearer = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim() ?? '';
    if (!bearer || !constantTimeTokenEquals(bearer, expectedSecret.expose())) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const bodyRes = await readLimitedBody(req, WEBHOOK_MAX_BODY_BYTES);
    if (!bodyRes.ok) {
      sendJson(res, bodyRes.reason === 'too_large' ? 413 : 400, {
        error: bodyRes.reason === 'too_large' ? 'Payload exceeds 64 KB limit' : 'Invalid body',
      });
      return;
    }

    let payload: unknown = null;
    if (bodyRes.raw.trim().length > 0) {
      try {
        payload = JSON.parse(bodyRes.raw);
      } catch {
        payload = { raw: bodyRes.raw };
      }
    }

    try {
      const triggered = await this.deps.triggerAutomation({ automationId, payload });
      if (!triggered.ok) {
        sendJson(res, triggered.status, { error: triggered.error });
        return;
      }
      sendJson(res, 202, { accepted: true, automationId, runId: triggered.runId });
    } catch (error) {
      this.deps.logger?.warn('Webhook otomasyonu tetiklenemedi', {
        automationId,
        error: error instanceof Error ? error.message : String(error),
      });
      sendJson(res, 500, { error: 'Internal error' });
    }
  }
}
