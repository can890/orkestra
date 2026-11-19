import {
  base64UrlDecode,
  connectRemoteTransport,
  type RemoteClientOptions,
  type RemoteClientTransport,
  type RemoteWelcomePayload,
} from '@orkestra/wire/remote';
import { connect, reconnectingTransport, type Connection } from '@orkestra/wire/rpc';
import {
  classifyConnectionError,
  connectionReducer,
  IDLE_STATUS,
  type ConnectionEvent,
  type ConnectionStatus,
} from './connection-state';
import type { PairingRecord } from './pairing-store';

export type ConnectionManagerOptions = {
  record: PairingRecord;
  clientName: string;
  platform: string;
  /** Her başarılı el sıkışmada masaüstünün bildirdiği güncel adresler/port. */
  onWelcome?: (welcome: RemoteWelcomePayload) => void;
  /** Testler için: gerçek WebSocket yerine başka bir taşıma. */
  dial?: (options: RemoteClientOptions) => Promise<RemoteClientTransport>;
  backoffMs?: number[];
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
  idleTimeoutMs?: number;
};

export type ConnectionManager = {
  /** Wire bağlantısı; kopuklukta çağrıları tutar ve yeniden bağlanınca devam eder. */
  readonly connection: Connection;
  status(): ConnectionStatus;
  subscribe(listener: (status: ConnectionStatus) => void): () => void;
  /**
   * Uygulama uzun süre arka plandaydıysa soket sessizce ölmüş olabilir: açık taşımayı kapatıp
   * hemen yeniden bağlanır. Zaten kopuk/bağlanıyorsa bir şey yapmaz.
   */
  refresh(): void;
  stop(): void;
};

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function createConnectionManager(options: ConnectionManagerOptions): ConnectionManager {
  const { record } = options;
  const secret = base64UrlDecode(record.secret);
  if (!secret) throw new Error('Kayıtlı eşleştirme sırrı okunamadı');
  const dial = options.dial ?? connectRemoteTransport;
  const sleep = options.sleep ?? abortableSleep;
  const stopSignal = new AbortController();

  let status: ConnectionStatus = connectionReducer(IDLE_STATUS, { type: 'start' });
  const listeners = new Set<(status: ConnectionStatus) => void>();
  let addresses = [...record.addresses];
  const port = record.port;
  let current: RemoteClientTransport | null = null;
  let lastWelcome: RemoteWelcomePayload | null = null;

  const dispatch = (event: ConnectionEvent): void => {
    const next = connectionReducer(status, event);
    if (next === status) return;
    status = next;
    for (const listener of listeners) listener(status);
  };

  async function dialOnce(): Promise<RemoteClientTransport> {
    let lastError: unknown = new Error('no address');
    const ordered = [...addresses];
    for (const address of ordered) {
      if (stopSignal.signal.aborted) break;
      try {
        const transport = await dial({
          address,
          port,
          deviceId: record.deviceId,
          secret: secret as Uint8Array,
          clientName: options.clientName,
          platform: options.platform,
          handshakeTimeoutMs: options.handshakeTimeoutMs,
          pingIntervalMs: options.pingIntervalMs,
          idleTimeoutMs: options.idleTimeoutMs,
        });
        // Çalışan adres bir sonraki denemede başa alınır.
        addresses = [address, ...addresses.filter((candidate) => candidate !== address)];
        current = transport;
        lastWelcome = transport.welcome;
        return transport;
      } catch (error) {
        lastError = error;
        const classified = classifyConnectionError(error);
        // Yanlış sır/sürüm: diğer adresleri denemek anlamsız.
        if (classified.terminal) throw error;
        if (classified.retryAfterMs && classified.issue === 'rate-limited') {
          dispatch({ type: 'attempt-failed', issue: classified.issue });
          await sleep(Math.min(classified.retryAfterMs, 60_000), stopSignal.signal);
          throw error;
        }
      }
    }
    dispatch({ type: 'attempt-failed', issue: classifyConnectionError(lastError).issue });
    throw lastError;
  }

  const transport = reconnectingTransport(dialOnce, {
    backoffMs: options.backoffMs ?? DEFAULT_BACKOFF_MS,
    shouldRetry: (error) => classifyConnectionError(error).terminal === null,
  });

  transport.onReconnect(() => {
    if (lastWelcome) {
      // Masaüstü güncel adreslerini bildirir (DHCP değişimi); port aynı kalır.
      if (lastWelcome.addresses.length > 0) {
        const known = new Set(lastWelcome.addresses);
        addresses = [...lastWelcome.addresses, ...addresses.filter((a) => !known.has(a))].slice(
          0,
          6
        );
      }
      options.onWelcome?.(lastWelcome);
    }
    dispatch({ type: 'ready', hostName: lastWelcome?.hostName ?? record.hostName });
  });
  transport.onDisconnect(() => {
    current = null;
    dispatch({ type: 'disconnected' });
  });
  transport.onTerminalFailure((error) => {
    if (stopSignal.signal.aborted) return;
    dispatch({ type: 'terminal', reason: classifyConnectionError(error).terminal ?? 'unknown' });
  });
  void transport.ready().catch(() => {});

  const connection = connect(transport);

  return {
    connection,
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh() {
      if (status.kind === 'connected') current?.close?.();
    },
    stop() {
      if (stopSignal.signal.aborted) return;
      stopSignal.abort();
      dispatch({ type: 'stop' });
      connection.dispose();
      transport.close();
      listeners.clear();
    },
  };
}
