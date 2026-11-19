import { useCallback, useEffect, useRef, useState } from 'react';
import { getLifecycleHooksClient } from '../api/browser/client';
import type { LifecycleHooksState } from '../api/contract';
import type { LifecycleHooksConfig } from '../api/hook-config';
import type { HookRunRecord } from '../api/hook-runs';

const RUN_POLL_MS = 3_000;

export type LifecycleHooksModel = {
  loading: boolean;
  /** Sunucudaki (kaydedilmiş) durum. */
  saved: LifecycleHooksState | null;
  runs: HookRunRecord[];
  save(config: LifecycleHooksConfig): Promise<{ success: true } | { success: false; error: string }>;
  clearRuns(): Promise<void>;
};

/** Kancalar ayar sayfası için Wire istemcisi: durum + (sayfa açıkken yoklanan) çalıştırma günlüğü. */
export function useLifecycleHooks(): LifecycleHooksModel {
  const [saved, setSaved] = useState<LifecycleHooksState | null>(null);
  const [runs, setRuns] = useState<HookRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      try {
        const client = await getLifecycleHooksClient();
        const [state, initialRuns] = await Promise.all([client.getState(), client.listRuns()]);
        if (!mounted.current) return;
        setSaved(state);
        setRuns(initialRuns);
        timer = setInterval(() => {
          void client
            .listRuns()
            .then((next) => mounted.current && setRuns(next))
            .catch(() => {});
        }, RUN_POLL_MS);
      } finally {
        if (mounted.current) setLoading(false);
      }
    })();
    return () => {
      mounted.current = false;
      if (timer) clearInterval(timer);
    };
  }, []);

  const save = useCallback(async (config: LifecycleHooksConfig) => {
    try {
      const client = await getLifecycleHooksClient();
      const result = await client.saveConfig(config);
      if (!result.success) return { success: false as const, error: result.error };
      if (mounted.current) setSaved(result.state);
      return { success: true as const };
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, []);

  const clearRuns = useCallback(async () => {
    const client = await getLifecycleHooksClient();
    await client.clearRuns();
    if (mounted.current) setRuns([]);
  }, []);

  return { loading, saved, runs, save, clearRuns };
}
