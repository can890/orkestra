import type { Controller } from '../../api/controller';
import { serve } from '../../api/serve';
import { base64UrlDecode, base64UrlEncode, randomBytes, utf8Decode, utf8Encode } from '../bytes';
import { createSecureTransport } from '../channel';
import { createFrameOpener, createFrameSealer, deriveChannelKeys } from '../crypto';
import {
  isRemoteDeviceId,
  REMOTE_CLOSE,
  REMOTE_MAX_HELLO_BYTES,
  REMOTE_NONCE_BYTES,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SECRET_BYTES,
  type RemoteAuthPayload,
  type RemoteChallenge,
  type RemoteErrorCode,
  type RemoteErrorFrame,
  type RemoteHello,
  type RemoteSocket,
  type RemoteWelcomePayload,
} from '../protocol';
import { AuthRateLimiter } from './rate-limiter';

export type RemoteHostInfo = {
  hostId: string;
  hostName: string;
  addresses: string[];
  port: number;
};

export type RemoteSessionInfo = {
  deviceId: string;
  clientName?: string;
  platform?: string;
  remoteAddress: string;
};

export type RemoteRejection = {
  reason: 'rate-limited' | 'busy' | 'bad-hello' | 'version' | 'timeout' | 'auth-failed' | 'revoked';
  remoteAddress: string;
  deviceId?: string;
};

export type RemoteServerOptions = {
  /**
   * Oturumlara sunulan denetleyici. Çağıran, bunu izin listesiyle filtrelenmiş olarak vermekle
   * yükümlüdür; sunucu kimlik doğrulamadan önce hiçbir Wire mesajını işlemez.
   */
  controller: Controller;
  /** Cihazın eşleştirme sırrı (32 bayt); bilinmeyen/iptal edilmiş cihaz için `null`. */
  lookupSecret(deviceId: string): Promise<Uint8Array | null>;
  hostInfo(): RemoteHostInfo;
  rateLimiter?: AuthRateLimiter;
  limits?: Partial<RemoteServerLimits>;
  onSessionOpen?(info: RemoteSessionInfo): void;
  onSessionClose?(info: RemoteSessionInfo): void;
  onRejected?(info: RemoteRejection): void;
  now?: () => number;
};

export type RemoteServerLimits = {
  maxSessions: number;
  maxPendingTotal: number;
  maxPendingPerAddress: number;
  handshakeTimeoutMs: number;
  idleTimeoutMs: number;
  /** Kimlik doğrulanmamış ikili çerçeve (auth) için üst sınır. */
  maxAuthFrameBytes: number;
};

const DEFAULT_LIMITS: RemoteServerLimits = {
  maxSessions: 8,
  maxPendingTotal: 32,
  maxPendingPerAddress: 6,
  handshakeTimeoutMs: 12_000,
  idleTimeoutMs: 90_000,
  maxAuthFrameBytes: 2048,
};

export type RemoteServer = {
  /** Kabul edilen her ham soket için çağrılır (ws dinleyicisi ya da test). */
  handleConnection(socket: RemoteSocket, remoteAddress: string): void;
  /** Cihazın açık bağlantılarını hemen kapatır; kapatılan oturum sayısını döner. */
  closeDevice(deviceId: string, code?: number, reason?: string): number;
  closeAll(code?: number, reason?: string): void;
  connectedDeviceIds(): string[];
};

type Session = { info: RemoteSessionInfo; close(code: number, reason: string): void };

export function createRemoteServer(options: RemoteServerOptions): RemoteServer {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const limiter = options.rateLimiter ?? new AuthRateLimiter({ now: options.now });
  const sessions = new Map<string, Session>();
  const pendingByAddress = new Map<string, number>();
  const pendingSockets = new Set<RemoteSocket>();
  let pendingTotal = 0;

  const addPending = (address: string): void => {
    pendingTotal += 1;
    pendingByAddress.set(address, (pendingByAddress.get(address) ?? 0) + 1);
  };
  const removePending = (address: string): void => {
    pendingTotal -= 1;
    const next = (pendingByAddress.get(address) ?? 1) - 1;
    if (next <= 0) pendingByAddress.delete(address);
    else pendingByAddress.set(address, next);
  };

  function handleConnection(socket: RemoteSocket, rawAddress: string): void {
    const address = normalizeAddress(rawAddress);
    const reject = (
      code: number,
      error: RemoteErrorCode,
      message: string,
      rejection: Omit<RemoteRejection, 'remoteAddress'>,
      retryAfterMs?: number
    ): void => {
      options.onRejected?.({ ...rejection, remoteAddress: address });
      sendText(socket, {
        t: 'error',
        code: error,
        message,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      } satisfies RemoteErrorFrame);
      closeQuietly(socket, code, error);
    };

    const ipDecision = limiter.check(`ip:${address}`);
    if (!ipDecision.allowed) {
      reject(
        REMOTE_CLOSE.RATE_LIMITED,
        'RATE_LIMITED',
        'Too many failed attempts',
        { reason: 'rate-limited' },
        ipDecision.retryAfterMs
      );
      return;
    }
    if (
      pendingTotal >= limits.maxPendingTotal ||
      (pendingByAddress.get(address) ?? 0) >= limits.maxPendingPerAddress
    ) {
      reject(REMOTE_CLOSE.BUSY, 'BUSY', 'Too many pending handshakes', { reason: 'busy' });
      return;
    }

    addPending(address);
    pendingSockets.add(socket);
    let phase: 'hello' | 'proof' | 'verifying' | 'open' | 'closed' = 'hello';
    let deviceId: string | undefined;
    let setup: Promise<HandshakeContext> | undefined;
    let queue: Promise<void> = Promise.resolve();

    const leavePending = (): void => {
      if (!pendingSockets.delete(socket)) return;
      removePending(address);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      if (phase === 'open' || phase === 'closed') return;
      phase = 'closed';
      leavePending();
      reject(REMOTE_CLOSE.HANDSHAKE_TIMEOUT, 'PROTOCOL', 'Handshake timed out', {
        reason: 'timeout',
        deviceId,
      });
    }, limits.handshakeTimeoutMs);
    (timer as { unref?: () => void }).unref?.();

    const fail = (
      code: number,
      error: RemoteErrorCode,
      message: string,
      reason: RemoteRejection['reason'],
      countAsFailure: boolean
    ): void => {
      if (phase === 'closed' || phase === 'open') return;
      phase = 'closed';
      leavePending();
      if (countAsFailure) {
        limiter.recordFailure(`ip:${address}`);
        if (deviceId) limiter.recordFailure(`device:${deviceId}`);
      }
      reject(code, error, message, { reason, deviceId });
    };

    socket.onClose(() => {
      if (phase === 'open') return;
      phase = 'closed';
      leavePending();
    });

    const handleHello = (data: string | Uint8Array): void => {
      if (typeof data !== 'string' || utf8Encode(data).byteLength > REMOTE_MAX_HELLO_BYTES) {
        fail(REMOTE_CLOSE.PROTOCOL, 'PROTOCOL', 'Malformed hello', 'bad-hello', true);
        return;
      }
      const hello = parseHello(data);
      if (!hello) {
        fail(REMOTE_CLOSE.PROTOCOL, 'PROTOCOL', 'Malformed hello', 'bad-hello', true);
        return;
      }
      if (hello.v !== REMOTE_PROTOCOL_VERSION) {
        fail(
          REMOTE_CLOSE.VERSION_UNSUPPORTED,
          'VERSION_UNSUPPORTED',
          'Unsupported version',
          'version',
          false
        );
        return;
      }
      deviceId = hello.deviceId;
      const deviceDecision = limiter.check(`device:${hello.deviceId}`);
      if (!deviceDecision.allowed) {
        phase = 'closed';
        leavePending();
        reject(
          REMOTE_CLOSE.RATE_LIMITED,
          'RATE_LIMITED',
          'Too many failed attempts',
          { reason: 'rate-limited', deviceId },
          deviceDecision.retryAfterMs
        );
        return;
      }
      const clientNonce = base64UrlDecode(hello.clientNonce);
      if (!clientNonce || clientNonce.byteLength !== REMOTE_NONCE_BYTES) {
        fail(REMOTE_CLOSE.PROTOCOL, 'PROTOCOL', 'Malformed hello', 'bad-hello', true);
        return;
      }
      const serverNonce = randomBytes(REMOTE_NONCE_BYTES);
      phase = 'proof';
      const claimed = hello.deviceId;
      setup = prepareHandshake(claimed, clientNonce, serverNonce);
      setup.catch(() => {});
      sendText(socket, {
        t: 'challenge',
        v: REMOTE_PROTOCOL_VERSION,
        serverNonce: base64UrlEncode(serverNonce),
      } satisfies RemoteChallenge);
    };

    async function prepareHandshake(
      claimedDeviceId: string,
      clientNonce: Uint8Array,
      serverNonce: Uint8Array
    ): Promise<HandshakeContext> {
      let secret: Uint8Array | null = null;
      try {
        secret = await options.lookupSecret(claimedDeviceId);
      } catch {
        secret = null;
      }
      const known = secret !== null && secret.byteLength === REMOTE_SECRET_BYTES;
      // Bilinmeyen/iptal cihaz için de rastgele bir sırla ilerlenir: yanıt biçimi ve süre
      // cihazın var olup olmadığını ele vermez; doğrulama doğal olarak başarısız olur.
      const effective = known && secret ? secret : randomBytes(REMOTE_SECRET_BYTES);
      const keys = await deriveChannelKeys('server', effective, clientNonce, serverNonce);
      return {
        known,
        sealer: createFrameSealer(keys.send, keys.sendDirection),
        opener: createFrameOpener(keys.receive, keys.receiveDirection),
      };
    }

    const handleProof = async (data: string | Uint8Array): Promise<void> => {
      if (typeof data === 'string' || data.byteLength > limits.maxAuthFrameBytes) {
        fail(REMOTE_CLOSE.PROTOCOL, 'PROTOCOL', 'Malformed frame', 'bad-hello', true);
        return;
      }
      phase = 'verifying';
      const context = await setup!;
      let auth: RemoteAuthPayload | null = null;
      try {
        auth = parseAuth(await context.opener.open(data));
      } catch {
        auth = null;
      }
      if (phase !== 'verifying') return;
      if (!auth || !context.known || auth.deviceId !== deviceId) {
        fail(REMOTE_CLOSE.AUTH_FAILED, 'AUTH_FAILED', 'Authentication failed', 'auth-failed', true);
        return;
      }
      // Doğrulama sürerken cihaz iptal edilmiş olabilir: yeniden sor.
      let stillActive = false;
      try {
        const current = await options.lookupSecret(auth.deviceId);
        stillActive = current !== null;
      } catch {
        stillActive = false;
      }
      if (phase !== 'verifying') return;
      if (!stillActive) {
        fail(REMOTE_CLOSE.REVOKED, 'AUTH_FAILED', 'Authentication failed', 'revoked', false);
        return;
      }
      if (sessions.size >= limits.maxSessions && !sessions.has(auth.deviceId)) {
        fail(REMOTE_CLOSE.BUSY, 'BUSY', 'Too many sessions', 'busy', false);
        return;
      }

      const welcome: RemoteWelcomePayload = {
        t: 'welcome',
        v: REMOTE_PROTOCOL_VERSION,
        ...options.hostInfo(),
      };
      const sealed = await context.sealer.seal(utf8Encode(JSON.stringify(welcome)));
      if (phase !== 'verifying') return;
      phase = 'open';
      leavePending();
      limiter.recordSuccess(`ip:${address}`);
      limiter.recordSuccess(`device:${auth.deviceId}`);
      socket.send(sealed);
      openSession(socket, address, auth, context);
    };

    socket.onMessage((data) => {
      queue = queue.then(async () => {
        if (phase === 'hello') handleHello(data);
        else if (phase === 'proof') await handleProof(data);
        else if (phase === 'verifying') {
          fail(REMOTE_CLOSE.PROTOCOL, 'PROTOCOL', 'Unexpected frame', 'bad-hello', true);
        }
      });
      queue.catch(() => {
        fail(REMOTE_CLOSE.PROTOCOL, 'PROTOCOL', 'Handshake failed', 'bad-hello', true);
      });
    });
  }

  function openSession(
    socket: RemoteSocket,
    address: string,
    auth: RemoteAuthPayload,
    context: HandshakeContext
  ): void {
    const previous = sessions.get(auth.deviceId);
    previous?.close(REMOTE_CLOSE.REPLACED, 'replaced');

    const transport = createSecureTransport({
      socket,
      sealer: context.sealer,
      opener: context.opener,
      idleTimeoutMs: limits.idleTimeoutMs,
      now: options.now,
    });
    const info: RemoteSessionInfo = {
      deviceId: auth.deviceId,
      remoteAddress: address,
      ...(auth.clientName ? { clientName: sanitizeLabel(auth.clientName) } : {}),
      ...(auth.platform ? { platform: sanitizeLabel(auth.platform) } : {}),
    };
    const stopServing = serve(transport, options.controller);
    const session: Session = {
      info,
      close(code, reason) {
        closeQuietly(socket, code, reason);
        transport.close?.();
      },
    };
    sessions.set(auth.deviceId, session);
    options.onSessionOpen?.(info);
    transport.onClosed(() => {
      stopServing();
      if (sessions.get(auth.deviceId) === session) sessions.delete(auth.deviceId);
      options.onSessionClose?.(info);
    });
  }

  return {
    handleConnection,
    closeDevice(deviceId, code = REMOTE_CLOSE.REVOKED, reason = 'revoked') {
      const session = sessions.get(deviceId);
      if (!session) return 0;
      session.close(code, reason);
      return 1;
    },
    closeAll(code = REMOTE_CLOSE.GOING_AWAY, reason = 'going away') {
      for (const session of [...sessions.values()]) session.close(code, reason);
      for (const socket of [...pendingSockets]) closeQuietly(socket, code, reason);
    },
    connectedDeviceIds: () => [...sessions.keys()],
  };
}

type HandshakeContext = {
  known: boolean;
  sealer: ReturnType<typeof createFrameSealer>;
  opener: ReturnType<typeof createFrameOpener>;
};

function parseHello(data: string): RemoteHello | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  const hello = value as Partial<RemoteHello> | null;
  if (
    !hello ||
    hello.t !== 'hello' ||
    typeof hello.v !== 'number' ||
    !isRemoteDeviceId(hello.deviceId) ||
    typeof hello.clientNonce !== 'string'
  ) {
    return null;
  }
  return hello as RemoteHello;
}

function parseAuth(plain: Uint8Array): RemoteAuthPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(plain));
  } catch {
    return null;
  }
  const auth = value as Partial<RemoteAuthPayload> | null;
  if (
    !auth ||
    auth.t !== 'auth' ||
    auth.v !== REMOTE_PROTOCOL_VERSION ||
    !isRemoteDeviceId(auth.deviceId)
  ) {
    return null;
  }
  return {
    t: 'auth',
    v: auth.v,
    deviceId: auth.deviceId,
    ...(typeof auth.clientName === 'string' ? { clientName: auth.clientName } : {}),
    ...(typeof auth.platform === 'string' ? { platform: auth.platform } : {}),
  };
}

/** Günlük/arayüzde gösterilecek istemci etiketi: kontrol karakterleri atılır, 64 ile kısaltılır. */
export function sanitizeLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64);
}

function normalizeAddress(address: string): string {
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

function sendText(socket: RemoteSocket, frame: RemoteErrorFrame | RemoteChallenge): void {
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    // Soket zaten kapanmış olabilir.
  }
}

function closeQuietly(socket: RemoteSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Soket zaten kapalı.
  }
}
