import { base64UrlDecode, base64UrlEncode, randomBytes, utf8Decode, utf8Encode } from './bytes';
import { createSecureTransport, type SecureTransport } from './channel';
import { createFrameOpener, createFrameSealer, deriveChannelKeys } from './crypto';
import {
  isRemoteDeviceId,
  REMOTE_CLOSE,
  REMOTE_MAX_FRAME_BYTES,
  REMOTE_NONCE_BYTES,
  REMOTE_PROTOCOL_VERSION,
  remoteWebSocketUrl,
  type RemoteAuthPayload,
  type RemoteChallenge,
  type RemoteErrorCode,
  type RemoteHello,
  type RemoteSocket,
  type RemoteSocketData,
  type RemoteWelcomePayload,
} from './protocol';

export type RemoteHandshakeErrorCode = RemoteErrorCode | 'UNREACHABLE' | 'TIMEOUT';

export class RemoteHandshakeError extends Error {
  constructor(
    readonly code: RemoteHandshakeErrorCode,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'RemoteHandshakeError';
  }

  /** `false`: aynı sırla yeniden denemek anlamsız (yanlış sır, iptal, sürüm uyumsuzluğu). */
  get retryable(): boolean {
    return this.code !== 'AUTH_FAILED' && this.code !== 'VERSION_UNSUPPORTED';
  }
}

export type RemoteClientOptions = {
  /** Sunucu adresi (IPv4/IPv6/ana makine adı) ve portu. `url` verilirse yok sayılır. */
  address?: string;
  port?: number;
  url?: string;
  deviceId: string;
  /** 32 baytlık eşleştirme sırrı (QR'daki `s` alanının base64url çözümü). */
  secret: Uint8Array;
  clientName?: string;
  platform?: string;
  /** Varsayılan: `globalThis.WebSocket`. Testler bellek içi bir soket verebilir. */
  createSocket?: (url: string, signal?: AbortSignal) => Promise<RemoteSocket> | RemoteSocket;
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
  idleTimeoutMs?: number;
  /** Dışarıdan iptal (ör. Happy Eyeballs yarışında kaybeden soket anında kapatılır). */
  signal?: AbortSignal;
};

export type RemoteClientTransport = SecureTransport & { welcome: RemoteWelcomePayload };

const DEFAULTS = {
  handshakeTimeoutMs: 10_000,
  pingIntervalMs: 12_000,
  idleTimeoutMs: 45_000,
};

/**
 * Tek bir fiziksel bağlantı açar ve el sıkışmayı tamamlar. Dönen taşıma doğrudan
 * `connect(transport)` ile ya da `reconnectingTransport(() => connectRemoteTransport(...))`
 * ile kullanılır. Sunucunun anahtar sahipliğini kanıtlayan ilk çerçevesi doğrulanana dek hiçbir
 * Wire mesajı gönderilmez.
 */
export async function connectRemoteTransport(
  options: RemoteClientOptions
): Promise<RemoteClientTransport> {
  if (!isRemoteDeviceId(options.deviceId)) {
    throw new RemoteHandshakeError('PROTOCOL', 'Invalid deviceId');
  }
  const url =
    options.url ??
    (options.address && options.port ? remoteWebSocketUrl(options.address, options.port) : null);
  if (!url) throw new RemoteHandshakeError('PROTOCOL', 'A url or address+port is required');
  if (options.signal?.aborted) {
    throw new RemoteHandshakeError('UNREACHABLE', 'Connection aborted');
  }
  const timeoutMs = options.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs;
  const attemptController = typeof AbortController === 'function' ? new AbortController() : null;
  const onExternalAbort = (): void => attemptController?.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  let socket: RemoteSocket;
  try {
    const createFn =
      options.createSocket ??
      ((targetUrl: string, sig?: AbortSignal) => webSocketAdapter(targetUrl, undefined, sig));
    socket = await withTimeout(
      Promise.resolve(createFn(url, attemptController?.signal)),
      timeoutMs,
      () => {
        attemptController?.abort();
        return new RemoteHandshakeError('UNREACHABLE', 'Connection timed out');
      },
      attemptController?.signal
    );
  } catch (error) {
    attemptController?.abort();
    options.signal?.removeEventListener('abort', onExternalAbort);
    if (error instanceof RemoteHandshakeError) throw error;
    throw new RemoteHandshakeError('UNREACHABLE', 'Connection failed');
  }

  try {
    const transport = await withTimeout(
      runHandshake(socket, options),
      timeoutMs,
      () => new RemoteHandshakeError('TIMEOUT', 'Handshake timed out'),
      attemptController?.signal
    );
    options.signal?.removeEventListener('abort', onExternalAbort);
    return transport;
  } catch (error) {
    options.signal?.removeEventListener('abort', onExternalAbort);
    try {
      socket.close(REMOTE_CLOSE.NORMAL, 'handshake failed');
    } catch {
      // zaten kapalı
    }
    throw error;
  }
}

function runHandshake(
  socket: RemoteSocket,
  options: RemoteClientOptions
): Promise<RemoteClientTransport> {
  return new Promise<RemoteClientTransport>((resolve, reject) => {
    const clientNonce = randomBytes(REMOTE_NONCE_BYTES);
    let stage: 'challenge' | 'welcome' | 'done' = 'challenge';
    let sealer: ReturnType<typeof createFrameSealer> | undefined;
    let opener: ReturnType<typeof createFrameOpener> | undefined;
    let pendingError: RemoteHandshakeError | undefined;

    const abort = (error: RemoteHandshakeError): void => {
      if (stage === 'done') return;
      stage = 'done';
      reject(error);
    };

    socket.onClose((code, reason) => {
      if (stage === 'done') return;
      abort(pendingError ?? errorForClose(code, reason));
    });

    socket.onMessage((data: RemoteSocketData) => {
      if (stage === 'challenge') {
        if (typeof data !== 'string') return abort(protocolError());
        const frame = parseTextFrame(data);
        if (frame?.t === 'error') {
          pendingError = errorFromFrame(frame);
          return;
        }
        const challenge = frame as Partial<RemoteChallenge> | null;
        const serverNonce =
          challenge?.t === 'challenge' && typeof challenge.serverNonce === 'string'
            ? base64UrlDecode(challenge.serverNonce)
            : null;
        if (!serverNonce || serverNonce.byteLength !== REMOTE_NONCE_BYTES) {
          return abort(protocolError());
        }
        stage = 'welcome';
        void deriveChannelKeys('client', options.secret, clientNonce, serverNonce).then(
          (keys) => {
            if (stage !== 'welcome') return;
            sealer = createFrameSealer(keys.send, keys.sendDirection);
            opener = createFrameOpener(keys.receive, keys.receiveDirection);
            const auth: RemoteAuthPayload = {
              t: 'auth',
              v: REMOTE_PROTOCOL_VERSION,
              deviceId: options.deviceId,
              ...(options.clientName ? { clientName: options.clientName } : {}),
              ...(options.platform ? { platform: options.platform } : {}),
            };
            void sealer.seal(utf8Encode(JSON.stringify(auth))).then(
              (sealed) => socket.send(sealed),
              () => abort(protocolError())
            );
          },
          () => abort(new RemoteHandshakeError('PROTOCOL', 'Key derivation failed'))
        );
        return;
      }

      if (stage === 'welcome') {
        if (typeof data === 'string') {
          const frame = parseTextFrame(data);
          if (frame?.t === 'error') pendingError = errorFromFrame(frame);
          else abort(protocolError());
          return;
        }
        if (!opener || data.byteLength > REMOTE_MAX_FRAME_BYTES) return abort(protocolError());
        const currentOpener = opener;
        void currentOpener.open(data).then(
          (plain) => {
            if (stage !== 'welcome') return;
            const welcome = parseWelcome(plain);
            if (!welcome || !sealer) return abort(protocolError());
            stage = 'done';
            const transport = createSecureTransport({
              socket,
              sealer,
              opener: currentOpener,
              pingIntervalMs: options.pingIntervalMs ?? DEFAULTS.pingIntervalMs,
              idleTimeoutMs: options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
            });
            resolve(Object.assign(transport, { welcome }));
          },
          // Sunucu sırrı bilmiyor (ya da kurcalanmış çerçeve): yanıt güvenilmez.
          () => abort(new RemoteHandshakeError('AUTH_FAILED', 'Server could not prove the secret'))
        );
      }
    });

    const hello: RemoteHello = {
      t: 'hello',
      v: REMOTE_PROTOCOL_VERSION,
      deviceId: options.deviceId,
      clientNonce: base64UrlEncode(clientNonce),
    };
    socket.send(JSON.stringify(hello));
  });
}

function parseTextFrame(data: string): ({ t?: string } & Record<string, unknown>) | null {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseWelcome(plain: Uint8Array): RemoteWelcomePayload | null {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(plain));
  } catch {
    return null;
  }
  const welcome = value as Partial<RemoteWelcomePayload> | null;
  if (
    !welcome ||
    welcome.t !== 'welcome' ||
    welcome.v !== REMOTE_PROTOCOL_VERSION ||
    typeof welcome.hostId !== 'string' ||
    typeof welcome.hostName !== 'string' ||
    typeof welcome.port !== 'number' ||
    !Array.isArray(welcome.addresses)
  ) {
    return null;
  }
  return {
    t: 'welcome',
    v: welcome.v,
    hostId: welcome.hostId,
    hostName: welcome.hostName,
    port: welcome.port,
    addresses: welcome.addresses.filter((entry): entry is string => typeof entry === 'string'),
  };
}

function errorFromFrame(frame: Record<string, unknown>): RemoteHandshakeError {
  const code = frame.code;
  const known: RemoteErrorCode[] = [
    'AUTH_FAILED',
    'RATE_LIMITED',
    'VERSION_UNSUPPORTED',
    'PROTOCOL',
    'BUSY',
  ];
  const mapped = known.find((entry) => entry === code) ?? 'PROTOCOL';
  const retryAfterMs = typeof frame.retryAfterMs === 'number' ? frame.retryAfterMs : undefined;
  return new RemoteHandshakeError(mapped, `Server rejected the handshake: ${mapped}`, retryAfterMs);
}

function errorForClose(code: number, reason: string): RemoteHandshakeError {
  switch (code) {
    case REMOTE_CLOSE.AUTH_FAILED:
    case REMOTE_CLOSE.REVOKED:
      return new RemoteHandshakeError('AUTH_FAILED', 'Authentication failed');
    case REMOTE_CLOSE.RATE_LIMITED:
      return new RemoteHandshakeError('RATE_LIMITED', 'Too many failed attempts');
    case REMOTE_CLOSE.VERSION_UNSUPPORTED:
      return new RemoteHandshakeError('VERSION_UNSUPPORTED', 'Protocol version not supported');
    case REMOTE_CLOSE.BUSY:
      return new RemoteHandshakeError('BUSY', 'Host is busy');
    case REMOTE_CLOSE.PROTOCOL:
      return new RemoteHandshakeError('PROTOCOL', `Protocol error${reason ? `: ${reason}` : ''}`);
    default:
      return new RemoteHandshakeError('UNREACHABLE', 'Connection closed during handshake');
  }
}

function protocolError(): RemoteHandshakeError {
  return new RemoteHandshakeError('PROTOCOL', 'Malformed handshake');
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RemoteHandshakeError('UNREACHABLE', 'Connection aborted'));
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new RemoteHandshakeError('UNREACHABLE', 'Connection aborted'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(onTimeout());
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

type WebSocketLike = {
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
};

type WebSocketCtor = new (url: string) => WebSocketLike;

/** Tarayıcı/Node `WebSocket`'ini `RemoteSocket`'e uyarlar; bağlantı açılınca çözülür. */
export function webSocketAdapter(
  url: string,
  Ctor: WebSocketCtor | undefined = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket,
  signal?: AbortSignal
): Promise<RemoteSocket> {
  return new Promise<RemoteSocket>((resolve, reject) => {
    if (!Ctor) {
      reject(new Error('WebSocket is not available'));
      return;
    }
    if (signal?.aborted) {
      reject(new Error('Connection aborted'));
      return;
    }
    const ws = new Ctor(url);
    ws.binaryType = 'arraybuffer';
    let messageCb: ((data: RemoteSocketData) => void) | undefined;
    let closeCb: ((code: number, reason: string) => void) | undefined;
    let opened = false;
    let settled = false;
    let closedInfo: { code: number; reason: string } | undefined;
    const queued: RemoteSocketData[] = [];

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close(1000, 'cancelled');
      } catch {
        // zaten kapalı
      }
      reject(new Error('Connection aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    ws.addEventListener('open', () => {
      signal?.removeEventListener('abort', onAbort);
      if (settled || signal?.aborted) {
        try {
          ws.close(1000, 'cancelled');
        } catch {
          // zaten kapalı
        }
        return;
      }
      opened = true;
      settled = true;
      resolve({
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
        onMessage(cb) {
          messageCb = cb;
          for (const item of queued.splice(0)) cb(item);
        },
        onClose(cb) {
          closeCb = cb;
          if (closedInfo) cb(closedInfo.code, closedInfo.reason);
        },
      });
    });
    ws.addEventListener('message', ((event: { data: unknown }) => {
      const data =
        typeof event.data === 'string'
          ? event.data
          : event.data instanceof ArrayBuffer
            ? new Uint8Array(event.data)
            : null;
      if (data === null) return;
      if (messageCb) messageCb(data);
      else queued.push(data);
    }) as (event: never) => void);
    ws.addEventListener('close', ((event: { code: number; reason: string }) => {
      signal?.removeEventListener('abort', onAbort);
      if (!opened && !settled) {
        settled = true;
        reject(new Error('Connection failed'));
      }
      closedInfo = { code: event.code, reason: event.reason };
      closeCb?.(event.code, event.reason);
    }) as (event: never) => void);
    ws.addEventListener('error', () => {
      signal?.removeEventListener('abort', onAbort);
      if (!opened && !settled) {
        settled = true;
        reject(new Error('Connection failed'));
      }
    });
  });
}
