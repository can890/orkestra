import type { HostRef } from '@orkestra/core/primitives/host/api';
import { Button } from '@orkestra/ui/react/primitives';
import { useMemo } from 'react';
import { ProviderUsageDetails } from '@core/features/usage-limits/browser/provider-usage-details';
import {
  useMinuteClock,
  useUsageLimits,
} from '@core/features/usage-limits/browser/use-usage-limits';

/**
 * Ayarlar sayfasındaki tek sağlayıcı kartı: kenar çubuğu göstergesi ve Orkestra ile aynı ana
 * süreç önbelleğini kullanır; "Yenile" önbelleği atlayıp sağlayıcıdan yeniden okur.
 */
export function ProviderUsageCard({ host, providerId }: { host: HostRef; providerId: string }) {
  const providerIds = useMemo(() => [providerId], [providerId]);
  const { snapshot, isLoading, isError, isRefreshing, refresh } = useUsageLimits(host, providerIds);
  const now = useMinuteClock();
  const usage = snapshot?.providers.find((candidate) => candidate.providerId === providerId);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <ProviderUsageDetails
        providerId={providerId}
        usage={usage ?? null}
        now={now}
        isLoading={isLoading}
        isError={isError}
        showBalances
      />
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="ghost" disabled={isRefreshing} onClick={refresh}>
          {isRefreshing ? 'Sorgulanıyor…' : 'Yenile'}
        </Button>
      </div>
    </div>
  );
}
