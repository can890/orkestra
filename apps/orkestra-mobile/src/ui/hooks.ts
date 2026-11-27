import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ConnectionManager } from '@/core/connection-manager';
import type { ConnectionStatus } from '@/core/connection-state';
import { describeCallError, type RemoteApi } from '@/core/wire-client';

export function useConnectionStatus(manager: ConnectionManager): ConnectionStatus {
  return useSyncExternalStore(manager.subscribe, manager.status, manager.status);
}

export type Loadable<T> = { data: T | null; error: string | null; loading: boolean };

const LIVE_RETRY_DELAYS_MS = [1_500, 3_000, 6_000, 10_000] as const;
const PERMANENT_LIVE_ERROR_CODES = new Set([
  'UNKNOWN_TOPIC',
  'UNKNOWN_PROCEDURE',
  'CONTRACT_MISMATCH',
  'NOT_FOUND',
  'NOT_ALLOWED',
]);

function errorCodeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
}

/** Canlı (Wire live) konuya abone olur; masaüstü değiştikçe veri kendiliğinden güncellenir. */
export function useLive<T>(
  api: RemoteApi,
  topic: string | null,
  map: (data: unknown) => T
): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ data: null, error: null, loading: true });
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    if (topic === null) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    setState({ data: null, error: null, loading: true });
    let active = true;
    let subscription: ReturnType<RemoteApi['live']> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryAttempt = 0;
    let needsResubscribe = false;

    const clearTimer = (): void => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const subscribe = (): void => {
      if (!active) return;
      clearTimer();
      needsResubscribe = false;
      subscription?.dispose();
      const currentSub = api.live<unknown>(topic, (value) => {
        if (!active || subscription !== currentSub) return;
        retryAttempt = 0;
        needsResubscribe = false;
        setState({ data: mapRef.current(value), error: null, loading: false });
      });
      subscription = currentSub;
      currentSub.ready.catch((error: unknown) => {
        if (!active || subscription !== currentSub) return;
        const code = errorCodeOf(error);
        setState((prev) => ({
          data: prev.data,
          error: describeCallError(error),
          loading: false,
        }));
        if (!PERMANENT_LIVE_ERROR_CODES.has(code)) {
          needsResubscribe = true;
          const delay =
            LIVE_RETRY_DELAYS_MS[Math.min(retryAttempt, LIVE_RETRY_DELAYS_MS.length - 1)] ??
            10_000;
          retryAttempt += 1;
          clearTimer();
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (active && needsResubscribe) subscribe();
          }, delay);
        }
      });
    };

    const triggerImmediateRetry = (): void => {
      if (!active || !needsResubscribe) return;
      retryAttempt = 0;
      subscribe();
    };

    subscribe();
    const unsubReconnect = api.onReconnect?.(triggerImmediateRetry);
    const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
    if (hasWindow) window.addEventListener('online', triggerImmediateRetry);

    return () => {
      active = false;
      clearTimer();
      unsubReconnect?.();
      if (hasWindow) window.removeEventListener('online', triggerImmediateRetry);
      subscription?.dispose();
    };
  }, [api, topic]);
  return state;
}

/**
 * Tek seferlik çağrı; bağlantı yeniden kurulunca ve (varsa) aralıkla yenilenir.
 * `key` değişince yeniden yüklenir.
 */
export function useQuery<T>(
  manager: ConnectionManager,
  load: () => Promise<T>,
  key: string,
  pollMs = 0
): Loadable<T> & { reload: () => void } {
  const status = useConnectionStatus(manager);
  const connected = status.kind === 'connected';
  const [state, setState] = useState<Loadable<T>>({ data: null, error: null, loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setState((previous) => ({ ...previous, loading: true }));
    loadRef.current().then(
      (data) => active && setState({ data, error: null, loading: false }),
      (error: unknown) =>
        active &&
        setState((previous) => ({
          data: previous.data,
          error: describeCallError(error),
          loading: false,
        }))
    );
    return () => {
      active = false;
    };
  }, [key, connected, tick]);

  useEffect(() => {
    if (!pollMs) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, pollMs);
    return () => clearInterval(timer);
  }, [pollMs, reload]);

  return { ...state, reload };
}
