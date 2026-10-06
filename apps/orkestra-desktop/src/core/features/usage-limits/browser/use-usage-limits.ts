import type { HostRef } from '@orkestra/core/primitives/host/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getUsageLimitsClient } from '@core/features/usage-limits/api/browser/client';
import type { UsageSnapshot } from '@core/features/usage-limits/api/usage-limits';

/** Ana süreç önbelleği 3 dakikada tazelenir; gösterge de aynı sıklıkla sorar. */
const REFRESH_INTERVAL_MS = 3 * 60_000;
// Codex/Antigravity sorguları yavaş olabilir; varsayılan 30 sn çağrı süresi yetmeyebilir.
const CALL_TIMEOUT_MS = 75_000;

function usageQueryKey(host: HostRef, providerIds: readonly string[]) {
  return ['usage-limits', host.type, host.id, providerIds.join(',')] as const;
}

async function fetchUsage(
  host: HostRef,
  providerIds: readonly string[],
  force: boolean
): Promise<UsageSnapshot> {
  const client = await getUsageLimitsClient();
  return client.get(
    { host, providerIds: [...providerIds], ...(force ? { force } : {}) },
    { timeoutMs: CALL_TIMEOUT_MS }
  );
}

/** Bir makinedeki sağlayıcıların kullanım pencereleri; `refresh` önbelleği atlayıp yeniden okur. */
export function useUsageLimits(host: HostRef, providerIds: readonly string[]) {
  const queryClient = useQueryClient();
  const key = usageQueryKey(host, providerIds);
  const query = useQuery({
    queryKey: key,
    queryFn: () => fetchUsage(host, providerIds, false),
    staleTime: 60_000,
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: () => fetchUsage(host, providerIds, true),
    onSuccess: (snapshot) => queryClient.setQueryData(key, snapshot),
  });
  return {
    snapshot: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    isRefreshing: refresh.isPending || query.isFetching,
    refresh: () => refresh.mutate(),
  };
}

/** Göreli zamanların ("2 sa sonra") kendiliğinden ilerlemesi için dakikalık saat. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
