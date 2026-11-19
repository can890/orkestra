import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ConnectionManager } from '@/core/connection-manager';
import type { ConnectionStatus } from '@/core/connection-state';
import { describeCallError, type RemoteApi } from '@/core/wire-client';

export function useConnectionStatus(manager: ConnectionManager): ConnectionStatus {
  return useSyncExternalStore(manager.subscribe, manager.status, manager.status);
}

export type Loadable<T> = { data: T | null; error: string | null; loading: boolean };

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
    if (topic === null) return;
    setState({ data: null, error: null, loading: true });
    let active = true;
    const subscription = api.live<unknown>(topic, (value) => {
      if (active) setState({ data: mapRef.current(value), error: null, loading: false });
    });
    subscription.ready.catch((error: unknown) => {
      if (active) setState({ data: null, error: describeCallError(error), loading: false });
    });
    return () => {
      active = false;
      subscription.dispose();
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
