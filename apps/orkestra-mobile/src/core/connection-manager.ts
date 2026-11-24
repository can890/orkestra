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

export type DynamicAddressResolution = {
  addresses: string[];
  port?: number;
};

export type ConnectionManagerOptions = {
  record: PairingRecord;
  clientName: string;
  platform: string;
  /** Kayıtlı adreslerden önce hızlıca denenir (ör. USB adb reverse için 127.0.0.1). */
  localCandidates?: string[];
  /** Kayıtlı adresler ulaşılamazsa denenir (ör. mDNS `.local` adı). */
  fallbackCandidates?: string[];
  /** Kayıtlı adresler başarısız olunca canlı tünel (ör. trycloudflare.com) adreslerini tazeler. */
  resolveDynamicAddresses?: () => Promise<DynamicAddressResolution | null>;
  /** Keşiften gelen güncel adres/port ile bağlantı başarılı olunca bildirilir. */
  onDynamicUpdate?: (update: DynamicAddressResolution) => void;
  /** Bir tam bağlantı turu (tüm adaylar + keşif) başarısız olunca çağrılır (multi-host failover). */
  onRoundFailed?: () => void;
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
   * Uygulama arka plandan dönünce veya ağ değişince: bağlıysa soketi körlemesine kesmeden
   * canlılık ping'i atar (yanıt yoksa anında yeniler); kopuksa bekleme süresini atlayıp hemen bağlanır.
   */
  verifyConnection(): void;
  /**
   * Kullanıcı "Yenile" dediğinde: bağlıysa taze bağlantı açar, kopuk/beklemedeyse beklemeden hemen bağlanır.
   */
  refresh(): void;
  stop(): void;
};

const DEFAULT_BACKOFF_MS = [500, 1_000, 2_000, 3_000, 5_000];
const DEFAULT_MOBILE_PING_MS = 12_000;
const DEFAULT_MOBILE_IDLE_MS = 45_000;
const PROBE_TIMEOUT_MS = 3_000;
const HAPPY_EYEBALLS_STAGGER_MS = 250;

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
  let port = record.port;
  let current: RemoteClientTransport | null = null;
  let lastWelcome: RemoteWelcomePayload | null = null;
  let lastGoodAddress: string | null = null;
  let probeInFlight = false;

  const dispatch = (event: ConnectionEvent): void => {
    const next = connectionReducer(status, event);
    if (next === status) return;
    status = next;
    for (const listener of listeners) listener(status);
  };

  /**
   * Happy Eyeballs paralel bağlantı yarışı:
   * - En son çalışan adres (`lastGoodAddress`) ve yerel/LAN adayları anında denenir.
   * - `wss://` tünel adresi yalnızca 250ms gecikmeyle (veya son çalışan adres tünelse anında)
   *   paralel başlatılır; 5G'deyken ölü LAN IP'lerinin 5-10sn bekletmesi tamamen biter.
   * - İlk el sıkışmayı tamamlayan kazanır; diğer denemeler `AbortSignal` ile anında kapatılır.
   */
  async function tryAddressList(
    candidates: readonly string[],
    dialPort: number
  ): Promise<{ transport: RemoteClientTransport; address: string } | { lastError: unknown }> {
    if (candidates.length === 0) return { lastError: new Error('no address') };

    // Tek aday veya test `dial` enjeksiyonunda seri/deterministik akış korunsun (test kararlılığı).
    if (candidates.length === 1 || options.dial) {
      let lastError: unknown = new Error('no address');
      for (const address of candidates) {
        if (stopSignal.signal.aborted) break;
        const isTunnel = address.startsWith('wss://');
        const baseTimeout = options.handshakeTimeoutMs ?? 10_000;
        const perAttemptTimeout = isTunnel ? baseTimeout : Math.min(baseTimeout, 2_200);
        try {
          const transport = await dial({
            address,
            port: dialPort,
            deviceId: record.deviceId,
            secret: secret as Uint8Array,
            clientName: options.clientName,
            platform: options.platform,
            handshakeTimeoutMs: perAttemptTimeout,
            pingIntervalMs: options.pingIntervalMs ?? DEFAULT_MOBILE_PING_MS,
            idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_MOBILE_IDLE_MS,
            signal: stopSignal.signal,
          });
          return { transport, address };
        } catch (error) {
          lastError = error;
          const classified = classifyConnectionError(error);
          if (classified.terminal) throw error;
          if (classified.retryAfterMs && classified.issue === 'rate-limited') {
            dispatch({ type: 'attempt-failed', issue: classified.issue });
            await sleep(Math.min(classified.retryAfterMs, 60_000), stopSignal.signal);
            throw error;
          }
        }
      }
      return { lastError };
    }

    const raceController = new AbortController();
    const onStop = (): void => raceController.abort();
    stopSignal.signal.addEventListener('abort', onStop, { once: true });

    const baseTimeout = options.handshakeTimeoutMs ?? 10_000;
    const preferTunnel = Boolean(lastGoodAddress && lastGoodAddress.startsWith('wss://'));

    return await new Promise<
      { transport: RemoteClientTransport; address: string } | { lastError: unknown }
    >((resolve, reject) => {
      let settled = false;
      let remaining = candidates.length;
      let lastError: unknown = new Error('no address');
      let rateLimitError: { error: unknown; retryAfterMs: number } | null = null;

      const finish = (
        result:
          | { ok: true; transport: RemoteClientTransport; address: string }
          | { ok: false; lastError: unknown }
          | { terminal: unknown }
      ): void => {
        if (settled) return;
        settled = true;
        raceController.abort();
        stopSignal.signal.removeEventListener('abort', onStop);
        if ('terminal' in result) {
          reject(result.terminal);
          return;
        }
        if (result.ok) {
          resolve({ transport: result.transport, address: result.address });
          return;
        }
        if (rateLimitError) {
          dispatch({ type: 'attempt-failed', issue: 'rate-limited' });
          void sleep(Math.min(rateLimitError.retryAfterMs, 60_000), stopSignal.signal).then(() =>
            reject(rateLimitError!.error)
          );
          return;
        }
        resolve({ lastError: result.lastError });
      };

      candidates.forEach((address, index) => {
        const isTunnel = address.startsWith('wss://');
        const isLastGood = address === lastGoodAddress;
        const delayMs = isLastGood
          ? 0
          : isTunnel
            ? preferTunnel
              ? 0
              : HAPPY_EYEBALLS_STAGGER_MS
            : index === 0
              ? 0
              : 120;
        const perAttemptTimeout = isTunnel ? baseTimeout : Math.min(baseTimeout, 2_200);

        void (async () => {
          if (delayMs > 0) {
            await sleep(delayMs, raceController.signal);
          }
          if (settled || raceController.signal.aborted) {
            remaining -= 1;
            if (remaining === 0) finish({ ok: false, lastError });
            return;
          }
          try {
            const transport = await dial({
              address,
              port: dialPort,
              deviceId: record.deviceId,
              secret: secret as Uint8Array,
              clientName: options.clientName,
              platform: options.platform,
              handshakeTimeoutMs: perAttemptTimeout,
              pingIntervalMs: options.pingIntervalMs ?? DEFAULT_MOBILE_PING_MS,
              idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_MOBILE_IDLE_MS,
              signal: raceController.signal,
            });
            if (settled || raceController.signal.aborted) {
              transport.close?.();
              return;
            }
            finish({ ok: true, transport, address });
          } catch (error) {
            if (!settled) {
              lastError = error;
              const classified = classifyConnectionError(error);
              if (classified.terminal) {
                finish({ terminal: error });
                return;
              }
              if (classified.retryAfterMs && classified.issue === 'rate-limited') {
                rateLimitError = { error, retryAfterMs: classified.retryAfterMs };
              }
            }
            remaining -= 1;
            if (remaining === 0) finish({ ok: false, lastError });
          }
        })();
      });
    });
  }

  async function dialOnce(): Promise<RemoteClientTransport> {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const candidate of [
      ...(lastGoodAddress ? [lastGoodAddress] : []),
      ...(options.localCandidates ?? []),
      ...addresses,
      ...(options.fallbackCandidates ?? []),
    ]) {
      const trimmed = candidate.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      ordered.push(trimmed);
    }

    const first = await tryAddressList(ordered, port);
    if ('transport' in first) {
      lastGoodAddress = first.address;
      if (addresses.includes(first.address)) {
        addresses = [first.address, ...addresses.filter((c) => c !== first.address)];
      }
      current = first.transport;
      lastWelcome = first.transport.welcome;
      return first.transport;
    }

    let lastError: unknown = first.lastError;

    // Kayıtlı adreslere (LAN / eski tünel) ulaşılamadıysa canlı keşif adresini (trycloudflare.com) sorgula.
    if (!stopSignal.signal.aborted && options.resolveDynamicAddresses) {
      const resolved = await options.resolveDynamicAddresses().catch(() => null);
      if (resolved && resolved.addresses.length > 0 && !stopSignal.signal.aborted) {
        const nextPort = resolved.port ?? port;
        const freshCandidates = resolved.addresses.filter(
          (addr) => !seen.has(addr) || nextPort !== port
        );
        if (freshCandidates.length > 0) {
          const second = await tryAddressList(freshCandidates, nextPort);
          if ('transport' in second) {
            lastGoodAddress = second.address;
            port = nextPort;
            addresses = [
              second.address,
              ...resolved.addresses.filter((c) => c !== second.address),
              ...addresses.filter((c) => !resolved.addresses.includes(c)),
            ].slice(0, 6);
            options.onDynamicUpdate?.({ addresses, port });
            current = second.transport;
            lastWelcome = second.transport.welcome;
            return second.transport;
          }
          lastError = second.lastError;
        }
      }
    }

    dispatch({ type: 'attempt-failed', issue: classifyConnectionError(lastError).issue });
    options.onRoundFailed?.();
    throw lastError;
  }

  const transport = reconnectingTransport(dialOnce, {
    backoffMs: options.backoffMs ?? DEFAULT_BACKOFF_MS,
    shouldRetry: (error) => classifyConnectionError(error).terminal === null,
  });

  transport.onReconnect(() => {
    if (lastWelcome) {
      // Masaüstü güncel yerel adreslerini bildirir; son çalışan adres ve wss:// tüneli ASLA alta itilmez.
      if (lastWelcome.addresses.length > 0) {
        const known = new Set(lastWelcome.addresses);
        const preservedTunnels = addresses.filter((a) => a.startsWith('wss://') && !known.has(a));
        const merged = [
          ...(lastGoodAddress ? [lastGoodAddress] : []),
          ...preservedTunnels,
          ...lastWelcome.addresses,
          ...addresses.filter((a) => !known.has(a) && !a.startsWith('wss://')),
        ];
        addresses = [...new Set(merged)].slice(0, 6);
      }
      if (lastWelcome.port > 0) port = lastWelcome.port;
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
    verifyConnection() {
      if (stopSignal.signal.aborted) return;
      if (status.kind === 'connected' && current) {
        if (probeInFlight) return;
        probeInFlight = true;
        const active = current;
        const probeFn = typeof active.probe === 'function' ? active.probe(PROBE_TIMEOUT_MS) : null;
        if (!probeFn) {
          probeInFlight = false;
          return;
        }
        void probeFn
          .then((alive) => {
            if (!alive && current === active) {
              transport.reconnectNow();
            }
          })
          .finally(() => {
            probeInFlight = false;
          });
        return;
      }
      if (status.kind === 'reconnecting' || status.kind === 'connecting') {
        transport.reconnectNow();
      }
    },
    refresh() {
      if (stopSignal.signal.aborted) return;
      if (status.kind === 'connected' && current) {
        current.close?.();
        return;
      }
      if (status.kind === 'reconnecting' || status.kind === 'connecting') {
        transport.reconnectNow();
      }
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
