import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { describeCallError, unwrapResult, type RemoteApi } from './wire-client';

const snoozesSchema = z.record(
  z.string(),
  z.object({
    projectId: z.string(),
    until: z.number(),
  })
);
export type TaskSnoozes = z.infer<typeof snoozesSchema>;
export const SNOOZE_DURATIONS = [
  { label: '30 dakika', value: 1_800_000 },
  { label: '2 saat', value: 7_200_000 },
  { label: '24 saat', value: 86_400_000 },
] as const;

export function getSnooze(snoozes: TaskSnoozes, projectId: string, taskId: string) {
  const item = Object.hasOwn(snoozes, taskId) ? snoozes[taskId] : undefined;
  return item?.projectId === projectId && item.until > Date.now() ? item : undefined;
}

const EMPTY: TaskSnoozes = {};

export function useTaskSnoozes(api: RemoteApi, connected: boolean) {
  const [snapshot, setSnapshot] = useState<{ api: RemoteApi; items: TaskSnoozes }>();
  const [error, setError] = useState<{ api: RemoteApi; message: string }>();
  const generation = useRef(0);
  const writes = useRef(0);
  const items = snapshot?.api === api ? snapshot.items : EMPTY;
  useEffect(() => {
    if (!connected) return;
    let active = true;
    let loading = false;
    const load = async () => {
      if (document.visibilityState === 'hidden' || loading || writes.current) return;
      loading = true;
      const request = ++generation.current;
      try {
        const value = snoozesSchema.parse(
          unwrapResult(await api.call('mementos.getSidebarSnoozes', undefined))
        );
        if (active && request === generation.current) setSnapshot({ api, items: value });
      } catch {
        // Eski masaüstü sürümleri veya geçici bağlantı kaybı.
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    const onVisible = () => void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [api, connected]);
  useEffect(() => {
    const now = Date.now();
    const next = Math.min(
      ...Object.values(items)
        .map(({ until }) => until)
        .filter((until) => until > now)
    );
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(
      () => {
        setSnapshot((current) =>
          current?.api === api
            ? {
                api,
                items: Object.fromEntries(
                  Object.entries(current.items).filter(([, { until }]) => until > Date.now())
                ),
              }
            : current
        );
      },
      next - now + 1
    );
    return () => clearTimeout(timer);
  }, [api, items]);

  async function update(projectId: string, taskId: string, durationMs: number | null) {
    const request = ++generation.current;
    writes.current += 1;
    try {
      const value = snoozesSchema.parse(
        unwrapResult(
          await api.call('mementos.patchSidebarSnooze', {
            projectId,
            taskId,
            durationMs,
          })
        )
      );
      if (request === generation.current) {
        setSnapshot({ api, items: value });
        setError(undefined);
      }
      return true;
    } catch (cause) {
      if (request === generation.current) setError({ api, message: describeCallError(cause) });
      return false;
    } finally {
      writes.current -= 1;
    }
  }
  return { items, update, error: error?.api === api ? error.message : null };
}
