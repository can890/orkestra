import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { err, ok, type Result } from '@orkestra/shared';
import {
  ARTIFACT_SHARE_MAX_ACTIVE,
  ARTIFACT_SHARE_MAX_BYTES,
  type ArtifactShareError,
  type ArtifactShareInfo,
} from '../api/contract';

export type ArtifactShareFile = { path: string; bytes: Uint8Array };

type Share = {
  id: string;
  /** base64url belirteç; yalnızca bellekte ve istek yolunda bulunur. */
  token: string;
  tokenBytes: Buffer;
  name: string;
  createdAt: number;
  sizeBytes: number;
  entry: string;
  files: Map<string, { bytes: Uint8Array; contentType: string }>;
};

export type ArtifactShareServerOptions = {
  /** Dinlenecek arayüz; üretimde tüm arayüzler, testlerde `127.0.0.1`. */
  bindHost?: string;
  /** Adreslerde gösterilecek hostlar; varsayılan LAN IPv4 adresleri. */
  listAddresses?: () => string[];
  maxBytes?: number;
  maxActive?: number;
};

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  woff2: 'font/woff2',
};

export function contentTypeForPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

/** Paylaşım içi ad: göreli, `..` ve ters eğik çizgi yok. Disk yolu olarak asla kullanılmaz. */
export function isSafeSharePath(path: string): boolean {
  if (!path || path.length > 255 || path.startsWith('/')) return false;
  if (/[\\\0]/.test(path) || /[\u0000-\u001f]/.test(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export function lanIpv4Addresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "sandbox allow-scripts; default-src 'self' data: blob: 'unsafe-inline'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const;

function emptyResponse(res: ServerResponse, status: number, extra?: Record<string, string>): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Length': '0', ...extra });
  res.end();
}

/**
 * Artifact anlık görüntülerini yalnızca bellekten, belirteçli yollarla sunan HTTP sunucusu.
 * Hiç etkin paylaşım yokken port dinlenmez; son paylaşım bitince sunucu kapanır.
 */
export class ArtifactShareServer {
  private readonly shares = new Map<string, Share>();
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;
  private port = 0;
  /** Başlatma/durdurma çağrılarını sıraya koyar. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly bindHost: string;
  private readonly listAddresses: () => string[];
  private readonly maxBytes: number;
  private readonly maxActive: number;

  constructor(options: ArtifactShareServerOptions = {}) {
    this.bindHost = options.bindHost ?? '0.0.0.0';
    this.listAddresses = options.listAddresses ?? lanIpv4Addresses;
    this.maxBytes = options.maxBytes ?? ARTIFACT_SHARE_MAX_BYTES;
    this.maxActive = options.maxActive ?? ARTIFACT_SHARE_MAX_ACTIVE;
  }

  /** Sunucu şu an bir port dinliyor mu. */
  get listening(): boolean {
    return this.server !== null;
  }

  get listeningPort(): number | null {
    return this.server ? this.port : null;
  }

  create(input: {
    name: string;
    entry: string;
    files: ArtifactShareFile[];
  }): Promise<Result<ArtifactShareInfo, ArtifactShareError>> {
    return this.enqueue(async () => {
      const validated = this.validate(input);
      if (!validated.success) return validated;
      const addresses = this.listAddresses();
      if (addresses.length === 0) {
        return fail('no-network', 'Yerel ağ adresi bulunamadı. Bir ağa bağlı olduğundan emin ol.');
      }
      const started = await this.ensureStarted();
      if (!started.success) return started;

      const token = randomBytes(16).toString('base64url');
      const share: Share = {
        id: randomBytes(8).toString('hex'),
        token,
        tokenBytes: Buffer.from(token),
        name: input.name.slice(0, 200) || 'artifact',
        createdAt: Date.now(),
        sizeBytes: validated.data.total,
        entry: input.entry,
        files: validated.data.files,
      };
      this.shares.set(share.id, share);
      return ok(this.toInfo(share, addresses));
    });
  }

  list(): ArtifactShareInfo[] {
    const addresses = this.listAddresses();
    return [...this.shares.values()].map((share) => this.toInfo(share, addresses));
  }

  revoke(id: string): Promise<void> {
    return this.enqueue(async () => {
      this.shares.delete(id);
      if (this.shares.size === 0) await this.stopServer();
    });
  }

  /** Uygulama kapanırken: tüm paylaşımları bırak ve portu kapat. */
  dispose(): Promise<void> {
    return this.enqueue(async () => {
      this.shares.clear();
      await this.stopServer();
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private validate(input: {
    entry: string;
    files: ArtifactShareFile[];
  }): Result<{ files: Share['files']; total: number }, ArtifactShareError> {
    if (this.shares.size >= this.maxActive) {
      return fail('too-many', `En fazla ${this.maxActive} etkin paylaşım olabilir.`);
    }
    if (input.files.length === 0) return fail('empty', 'Paylaşılacak içerik yok.');
    const files: Share['files'] = new Map();
    let total = 0;
    for (const file of input.files) {
      if (!isSafeSharePath(file.path) || files.has(file.path)) {
        return fail('invalid-file', 'Geçersiz dosya adı.');
      }
      total += file.bytes.byteLength;
      if (total > this.maxBytes) {
        return fail(
          'too-large',
          `İçerik ${Math.round(this.maxBytes / 1024 / 1024)} MB sınırını aşıyor.`
        );
      }
      files.set(file.path, { bytes: file.bytes, contentType: contentTypeForPath(file.path) });
    }
    if (!files.has(input.entry)) return fail('invalid-file', 'Ana dosya içerikte yok.');
    return ok({ files, total });
  }

  private toInfo(share: Share, addresses: string[]): ArtifactShareInfo {
    return {
      id: share.id,
      name: share.name,
      createdAt: share.createdAt,
      sizeBytes: share.sizeBytes,
      urls: this.port ? addresses.map((a) => `http://${a}:${this.port}/a/${share.token}`) : [],
    };
  }

  private async ensureStarted(): Promise<Result<void, ArtifactShareError>> {
    if (this.server) return ok(undefined);
    const server = createServer((req, res) => this.handle(req, res));
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, this.bindHost, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch {
      return fail('listen-failed', 'Paylaşım sunucusu başlatılamadı.');
    }
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return ok(undefined);
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.port = 0;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
      for (const socket of this.sockets) socket.destroy();
    });
  }

  private findShare(token: string): Share | undefined {
    const candidate = Buffer.from(token);
    let match: Share | undefined;
    // Sabit zamanlı karşılaştırma: eşleşse bile tüm paylaşımlar taranır.
    for (const share of this.shares.values()) {
      if (share.tokenBytes.length !== candidate.length) continue;
      if (timingSafeEqual(share.tokenBytes, candidate)) match = share;
    }
    return match;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? '';
    if (method !== 'GET' && method !== 'HEAD') {
      emptyResponse(res, 405, { Allow: 'GET, HEAD' });
      return;
    }
    const target = (req.url ?? '').split(/[?#]/)[0] ?? '';
    const match = /^\/a\/([A-Za-z0-9_-]+)(?:\/(.*))?$/.exec(target);
    const share = match?.[1] ? this.findShare(match[1]) : undefined;
    if (!match || !share) {
      emptyResponse(res, 404);
      return;
    }
    let relative = share.entry;
    if (match[2]) {
      try {
        relative = decodeURIComponent(match[2]);
      } catch {
        emptyResponse(res, 404);
        return;
      }
    }
    // Yalnızca bellekteki anahtarlarla tam eşleşme; dosya sistemi hiç kullanılmaz.
    const file = isSafeSharePath(relative) ? share.files.get(relative) : undefined;
    if (!file) {
      emptyResponse(res, 404);
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': file.contentType,
      'Content-Length': String(file.bytes.byteLength),
    });
    if (method === 'HEAD') res.end();
    else res.end(file.bytes);
  }
}

function fail(
  code: ArtifactShareError['code'],
  message: string
): Result<never, ArtifactShareError> {
  return err({ code, message });
}
