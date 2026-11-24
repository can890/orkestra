// oxlint-disable-next-line typescript/triple-slash-reference -- `ws` için paket içi minimal tür bildirimi
/// <reference path="./ws.d.ts" />
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { REMOTE_MAX_FRAME_BYTES, REMOTE_WS_PATH, type RemoteSocket } from '../protocol';
import type { RemoteServer } from './server';

export type RemoteListenOptions = {
  /** Dinlenecek arayüz adresi; LAN/Tailscale erişimi için genelde `0.0.0.0`. */
  host: string;
  /** 0: işletim sistemi boş bir port seçer. */
  port: number;
};

export type RemoteListener = {
  port: number;
  close(): Promise<void>;
};

/** `ws` ile bir `RemoteServer`'ı TCP üzerinde dinler. Port açan tek yer burasıdır. */
export async function listenRemoteServer(
  server: RemoteServer,
  options: RemoteListenOptions
): Promise<RemoteListener> {
  const wss = new WebSocketServer({
    host: options.host,
    port: options.port,
    path: REMOTE_WS_PATH,
    maxPayload: REMOTE_MAX_FRAME_BYTES,
    perMessageDeflate: false,
    clientTracking: false,
  });
  wss.on('connection', (ws, request) => {
    server.handleConnection(adaptWebSocket(ws), request.socket.remoteAddress ?? 'unknown');
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      wss.off('listening', onListening as never);
      reject(error);
    };
    const onListening = (): void => {
      wss.off('error', onError as never);
      resolve();
    };
    wss.once('error', onError);
    wss.once('listening', onListening);
  });
  // Dinleme sonrası hatalar (ör. kabul hatası) süreci düşürmemeli.
  wss.on('error', () => {});
  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAll();
        wss.close(() => resolve());
      }),
  };
}

const WS_PROTOCOL_PING_INTERVAL_MS = 20_000;

function adaptWebSocket(ws: WebSocket): RemoteSocket {
  let messageCb: ((data: string | Uint8Array) => void) | undefined;
  let closeCb: ((code: number, reason: string) => void) | undefined;
  // RFC 6455 protokol düzeyi ping: Cloudflare tüneli ve 5G/CGNAT bağlantısını Android arka plandayken bile sıcak tutar.
  const pingTimer = setInterval(() => {
    if (ws.readyState === 1) {
      try {
        ws.ping();
      } catch {
        // Soket kapanıyor olabilir.
      }
    }
  }, WS_PROTOCOL_PING_INTERVAL_MS);
  (pingTimer as { unref?: () => void }).unref?.();

  ws.on('message', (raw: RawData, isBinary: boolean) => {
    const bytes = toBytes(raw);
    messageCb?.(isBinary ? bytes : new TextDecoder().decode(bytes));
  });
  ws.on('close', (code, reason) => {
    clearInterval(pingTimer);
    closeCb?.(code, reason.toString('utf8'));
  });
  ws.on('error', () => {
    // Hatalar `close` olayıyla da bildirilir; süreci düşürmesin.
  });
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => {
      clearInterval(pingTimer);
      ws.close(code, reason);
    },
    onMessage(cb) {
      messageCb = cb;
    },
    onClose(cb) {
      closeCb = cb;
    },
  };
}

function toBytes(raw: RawData): Uint8Array {
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw));
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return new Uint8Array(raw);
}
