import { useCallback, useEffect, useState } from 'react';
import type { ComputerUseState } from '../contract';
import { getComputerUseClient } from './client';

const POLL_INTERVAL_MS = 2000;

/**
 * Bir sohbetin bilgisayar kullanımı durumunu (kilitler, izinler, etkinlik günlüğü) yoklar.
 * Gösterge ve "Durdur" düğmesi doğru kalsın diye bileşen bağlıyken 2 sn'de bir yenilenir.
 */
export function useComputerUseState(conversationId: string) {
  const [state, setState] = useState<ComputerUseState | null>(null);

  const refresh = useCallback(async () => {
    try {
      const client = await getComputerUseClient();
      setState(await client.getState({ conversationId }));
    } catch {
      // Sonraki yoklama yeniden dener; gösterge eski durumda kalır.
    }
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void refresh();
    };
    tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refresh]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      const client = await getComputerUseClient();
      const result = await client.setConversationEnabled({ conversationId, enabled });
      await refresh();
      return result;
    },
    [conversationId, refresh]
  );

  const stop = useCallback(async () => {
    const client = await getComputerUseClient();
    await client.stop({ conversationId });
    await refresh();
  }, [conversationId, refresh]);

  return { state, refresh, setEnabled, stop };
}
