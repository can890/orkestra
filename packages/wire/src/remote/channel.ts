import type { Unsubscribe } from '@orkestra/shared';
import { isWireMessage, type WireMessage, type WireTransport } from '../api/protocol';
import { utf8Decode, utf8Encode } from './bytes';
import type { FrameOpener, FrameSealer } from './crypto';
import { RemoteFrameError } from './crypto';
import {
  REMOTE_CLOSE,
  REMOTE_MAX_FRAME_BYTES,
  type RemoteEnvelope,
  type RemoteSocket,
} from './protocol';

/** Şifreli çerçeveleri sayaç sırasıyla gönderir (seal asenkron olsa da sıra korunur). */
export function createSerialSender(sealer: FrameSealer, socket: RemoteSocket) {
  let chain: Promise<void> = Promise.resolve();
  return {
    /** Sayaç bu çağrıda atanır; gönderim sırası çağrı sırasıdır. */
    send(plaintext: Uint8Array, onError: (error: unknown) => void): void {
      const sealed = sealer.seal(plaintext);
      sealed.catch(() => {});
      chain = chain.then(async () => {
        try {
          socket.send(await sealed);
        } catch (error) {
          onError(error);
        }
      });
    },
  };
}

/** Şifreli çerçeveleri gelen sırayla çözer; bir hata sonraki işleri durdurmaz, çağıran kapatır. */
export function createSerialReceiver(opener: FrameOpener) {
  let chain: Promise<void> = Promise.resolve();
  return {
    push(
      frame: Uint8Array,
      onPlain: (plain: Uint8Array) => void,
      onError: (error: unknown) => void
    ): void {
      chain = chain.then(async () => {
        let plain: Uint8Array;
        try {
          plain = await opener.open(frame);
        } catch (error) {
          onError(error);
          return;
        }
        onPlain(plain);
      });
    },
  };
}

export function encodeEnvelope(envelope: RemoteEnvelope): Uint8Array {
  return utf8Encode(JSON.stringify(envelope));
}

/** Geçersiz zarf `null` döner. `wire` mesajları `isWireMessage` ile doğrulanır; blob/yükleme reddedilir. */
export function decodeEnvelope(plain: Uint8Array): RemoteEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(plain));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const envelope = value as { t?: unknown; m?: unknown };
  if (envelope.t === 'ping' || envelope.t === 'pong') return { t: envelope.t };
  if (envelope.t !== 'wire') return null;
  if (!isWireMessage(envelope.m)) return null;
  if (isForbiddenRemoteMessage(envelope.m)) return null;
  return { t: 'wire', m: envelope.m };
}

/**
 * Uzak taşıma ikili (blob) kanallarını ve dosya yüklemeyi hiç desteklemez: bunlar dosya
 * aktarımı demektir ve uzak yüzeyde açık değildir.
 */
export function isForbiddenRemoteMessage(message: WireMessage): boolean {
  if (message.kind.startsWith('blob-')) return true;
  return message.kind === 'call' && message.upload !== undefined;
}

export type SecureTransportOptions = {
  socket: RemoteSocket;
  sealer: FrameSealer;
  opener: FrameOpener;
  /** Ping gönderme aralığı (yalnızca istemci). 0/undefined: gönderme. */
  pingIntervalMs?: number;
  /** Bu süre boyunca hiçbir çerçeve gelmezse bağlantı kapatılır. 0/undefined: kapatma. */
  idleTimeoutMs?: number;
  now?: () => number;
};

export type SecureTransport = WireTransport & {
  /** Taşıma kapandığında nedeni ile bilgilendirir (bir kez). */
  onClosed(cb: (info: { code: number; reason: string }) => void): Unsubscribe;
  /**
   * Anlık canlılık yoklaması: hemen şifreli `ping` gönderir ve `timeoutMs` içinde karşıdan
   * herhangi bir çerçeve (ör. `pong`) gelmezse ölü soketi kapatıp `false` döner.
   */
  probe(timeoutMs?: number): Promise<boolean>;
};

/**
 * El sıkışması tamamlanmış kanalın `WireTransport`'u. Sayaçlar el sıkışmanın şifreli
 * çerçevelerinden devam eder (sealer/opener aynı örneklerdir).
 */
export function createSecureTransport(options: SecureTransportOptions): SecureTransport {
  const { socket, sealer, opener } = options;
  const now = options.now ?? Date.now;
  const messageListeners = new Set<(message: WireMessage) => void>();
  const disconnectListeners = new Set<() => void>();
  const closedListeners = new Set<(info: { code: number; reason: string }) => void>();
  const sender = createSerialSender(sealer, socket);
  const receiver = createSerialReceiver(opener);
  let closed = false;
  let lastInboundAt = now();
  let lastIdleCheckAt = now();
  const inboundWaiters = new Set<() => void>();
  const timers: Array<ReturnType<typeof setInterval>> = [];

  const finish = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearInterval(timer);
    for (const waiter of inboundWaiters) waiter();
    inboundWaiters.clear();
    for (const listener of closedListeners) listener({ code, reason });
    for (const listener of disconnectListeners) listener();
  };

  const fail = (code: number, reason: string): void => {
    if (closed) return;
    try {
      socket.close(code, reason);
    } catch {
      // Soket zaten kapalı olabilir.
    }
    finish(code, reason);
  };

  const sendPlain = (plain: Uint8Array): void => {
    sender.send(plain, () => fail(REMOTE_CLOSE.PROTOCOL, 'send failed'));
  };
  const sendEnvelope = (envelope: RemoteEnvelope): void => sendPlain(encodeEnvelope(envelope));

  socket.onMessage((data) => {
    if (closed) return;
    if (typeof data === 'string') {
      fail(REMOTE_CLOSE.PROTOCOL, 'unexpected text frame');
      return;
    }
    if (data.byteLength > REMOTE_MAX_FRAME_BYTES) {
      fail(REMOTE_CLOSE.TOO_LARGE, 'frame too large');
      return;
    }
    receiver.push(
      data,
      (plain) => {
        if (closed) return;
        lastInboundAt = now();
        if (inboundWaiters.size > 0) {
          for (const waiter of [...inboundWaiters]) waiter();
        }
        const envelope = decodeEnvelope(plain);
        if (!envelope) {
          fail(REMOTE_CLOSE.PROTOCOL, 'invalid envelope');
          return;
        }
        if (envelope.t === 'ping') sendEnvelope({ t: 'pong' });
        else if (envelope.t === 'wire') {
          for (const listener of messageListeners) listener(envelope.m);
        }
      },
      (error) => {
        // Sayaç/etiket hatası: tekrar, sırasız ya da kurcalanmış çerçeve.
        fail(
          error instanceof RemoteFrameError ? REMOTE_CLOSE.AUTH_FAILED : REMOTE_CLOSE.PROTOCOL,
          'frame rejected'
        );
      }
    );
  });
  socket.onClose((code, reason) => finish(code, reason));

  if (options.pingIntervalMs && options.pingIntervalMs > 0) {
    timers.push(setInterval(() => sendEnvelope({ t: 'ping' }), options.pingIntervalMs));
  }
  if (options.idleTimeoutMs && options.idleTimeoutMs > 0) {
    const idleTimeoutMs = options.idleTimeoutMs;
    const checkPeriodMs = Math.max(1000, Math.floor(idleTimeoutMs / 4));
    timers.push(
      setInterval(() => {
        const currentNow = now();
        const tickGap = currentNow - lastIdleCheckAt;
        lastIdleCheckAt = currentNow;
        // Mobil cihaz uyku/arka plan sonrası uyanınca zamanlayıcı sıçraması yaşanır:
        // çalışan soketi körlemesine kesmek yerine önce anlık ping gönderip kısa şans tanı.
        if (tickGap > Math.max(checkPeriodMs * 2.5, 10_000) && options.pingIntervalMs) {
          lastInboundAt = Math.max(lastInboundAt, currentNow - (idleTimeoutMs - 5_000));
          sendEnvelope({ t: 'ping' });
          return;
        }
        if (currentNow - lastInboundAt > idleTimeoutMs) {
          fail(REMOTE_CLOSE.GOING_AWAY, 'idle timeout');
        }
      }, checkPeriodMs)
    );
  }
  for (const timer of timers) (timer as { unref?: () => void }).unref?.();

  const probe = (timeoutMs = 3_000): Promise<boolean> => {
    if (closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (alive: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        inboundWaiters.delete(onInbound);
        if (!alive && !closed) fail(REMOTE_CLOSE.GOING_AWAY, 'probe timeout');
        resolve(alive);
      };
      const onInbound = (): void => done(!closed);
      inboundWaiters.add(onInbound);
      const timer = setTimeout(() => done(false), Math.max(500, timeoutMs));
      (timer as { unref?: () => void }).unref?.();
      sendEnvelope({ t: 'ping' });
    });
  };

  return {
    post(message) {
      if (closed) throw new Error('Remote transport disconnected');
      if (isForbiddenRemoteMessage(message)) throw new Error('Unsupported remote message');
      let plain = encodeEnvelope({ t: 'wire', m: message });
      if (plain.byteLength + FRAME_OVERHEAD > REMOTE_MAX_FRAME_BYTES) {
        plain = encodeEnvelope({ t: 'wire', m: oversizeReplacement(message) });
      }
      sendPlain(plain);
    },
    onMessage(cb): Unsubscribe {
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    },
    onDisconnect(cb): Unsubscribe {
      disconnectListeners.add(cb);
      return () => disconnectListeners.delete(cb);
    },
    onClosed(cb): Unsubscribe {
      closedListeners.add(cb);
      return () => closedListeners.delete(cb);
    },
    probe,
    close() {
      fail(REMOTE_CLOSE.NORMAL, 'closed');
      messageListeners.clear();
      disconnectListeners.clear();
    },
  };
}

const FRAME_OVERHEAD = 8 + 16;

/**
 * Çerçeve sınırını aşan bir yanıt/güncelleme sessizce kaybolursa karşı taraf sonsuza dek
 * bekler; bu yüzden anlamlı bir hataya çevrilir.
 */
function oversizeReplacement(message: WireMessage): WireMessage {
  const error = {
    code: 'SERIALIZATION' as const,
    message: 'Response too large for the remote transport',
  };
  if (message.kind === 'result') return { kind: 'result', id: message.id, ok: false, ...error };
  if (message.kind === 'update') {
    return { kind: 'topic-error', topic: message.topic, error, retrying: false };
  }
  throw new Error('Remote frame exceeds the maximum size');
}
