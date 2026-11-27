import type { HostRef } from '@orkestra/core/primitives/host/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getUsageLimitsClient } from '@core/features/usage-limits/api/browser/client';
import type {
  ConsumeResetCreditResult,
  UsageSnapshot,
} from '@core/features/usage-limits/api/usage-limits';

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
export function useUsageLimits(
  host: HostRef,
  providerIds: readonly string[],
  options: { enabled?: boolean } = {}
) {
  const queryClient = useQueryClient();
  const key = usageQueryKey(host, providerIds);
  const query = useQuery({
    queryKey: key,
    queryFn: () => fetchUsage(host, providerIds, false),
    enabled: options.enabled ?? true,
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

export type ConsumeResetCreditInput = {
  providerId: string;
  creditId?: string;
  idempotencyKey?: string;
};

/**
 * Bir sağlayıcının limit sıfırlama hakkını tüketir ve aynı makineye ait tüm kullanım önbelleklerini
 * taze veriyle günceller.
 */
export function useConsumeResetCredit(host: HostRef) {
  const queryClient = useQueryClient();
  const mutation = useMutation<ConsumeResetCreditResult, Error, ConsumeResetCreditInput>({
    mutationFn: async ({ providerId, creditId, idempotencyKey }) => {
      const client = await getUsageLimitsClient();
      return client.consumeResetCredit(
        {
          host,
          providerId,
          ...(creditId ? { creditId } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
        { timeoutMs: CALL_TIMEOUT_MS }
      );
    },
    onSuccess: (result, variables) => {
      if (result.usage) {
        const updated = result.usage;
        queryClient.setQueriesData<UsageSnapshot>(
          { queryKey: ['usage-limits', host.type, host.id] },
          (prev) => {
            if (!prev) return prev;
            const exists = prev.providers.some((p) => p.providerId === variables.providerId);
            return {
              providers: exists
                ? prev.providers.map((p) => (p.providerId === variables.providerId ? updated : p))
                : [...prev.providers, updated],
            };
          }
        );
      }
      void queryClient.invalidateQueries({ queryKey: ['usage-limits', host.type, host.id] });
    },
  });
  return {
    consumeResetCredit: (input: ConsumeResetCreditInput) => mutation.mutateAsync(input),
    isRedeeming: mutation.isPending,
    redeemingProviderId: mutation.isPending ? (mutation.variables?.providerId ?? null) : null,
  };
}
