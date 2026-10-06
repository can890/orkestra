import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { Button, Popover } from '@orkestra/ui/react/primitives';
import { Gauge } from 'lucide-react';
import type { ReactElement } from 'react';
import { evaluateUsageCapacity } from '@core/features/usage-limits/api/usage-capacity';
import {
  INDICATOR_USAGE_PROVIDERS,
  PINNED_USAGE_PROVIDERS,
  type ProviderUsage,
} from '@core/features/usage-limits/api/usage-limits';
import { ProviderUsageDetails } from '@core/features/usage-limits/browser/provider-usage-details';
import {
  formatUsagePercent,
  usageProviderName,
  usageToneClass,
} from '@core/features/usage-limits/browser/usage-format';
import {
  useMinuteClock,
  useUsageLimits,
} from '@core/features/usage-limits/browser/use-usage-limits';
import { cn } from '@core/primitives/styling/browser/cn';

/** Sabit sağlayıcılar her zaman, diğerleri yalnızca okunabilir pencereleri varsa görünür. */
function visibleProviders(providers: readonly ProviderUsage[]): ProviderUsage[] {
  return providers.filter(
    (usage) => PINNED_USAGE_PROVIDERS.includes(usage.providerId) || usage.windows.length > 0
  );
}

function SummaryChip({ usage, now }: { usage: ProviderUsage; now: number }) {
  const capacity = evaluateUsageCapacity(usage, now);
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      <span>{usageProviderName(usage.providerId)}</span>
      <span className={cn('font-medium tabular-nums', usageToneClass(capacity.status))}>
        {capacity.window ? formatUsagePercent(capacity.window.usedPercent) : '–'}
      </span>
    </span>
  );
}

/**
 * Kenar çubuğu altbilgisindeki kompakt abonelik kullanımı göstergesi. Bu Mac'teki ajan
 * oturumlarından okunur; ayrıntılar açılır pencerede ilerleme çubuklarıyla gösterilir.
 * `trigger`, yerleşimin kendi satır düğmesidir (ör. kenar çubuğu menü düğmesi).
 */
export function UsageLimitsIndicator({ trigger }: { trigger: ReactElement }) {
  const now = useMinuteClock();
  const { snapshot, isLoading, isError, isRefreshing, refresh } = useUsageLimits(
    LOCAL_HOST_REF,
    INDICATOR_USAGE_PROVIDERS
  );
  const providers = visibleProviders(snapshot?.providers ?? []);
  return (
    <Popover.Root>
      <Popover.Trigger render={trigger} aria-label="Abonelik kullanımı">
        <span className="flex min-w-0 items-center gap-2">
          <Gauge className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
          {providers.length === 0 ? (
            <span className="truncate">{isLoading ? 'Kullanım…' : 'Kullanım'}</span>
          ) : (
            <span className="flex min-w-0 items-center gap-2 truncate text-xs">
              {providers.map((usage) => (
                <SummaryChip key={usage.providerId} usage={usage} now={now} />
              ))}
            </span>
          )}
        </span>
      </Popover.Trigger>
      <Popover.Content side="top" align="start" className="flex w-80 flex-col gap-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-foreground">Abonelik kullanımı</span>
          <Button type="button" size="sm" variant="ghost" disabled={isRefreshing} onClick={refresh}>
            {isRefreshing ? 'Yenileniyor…' : 'Yenile'}
          </Button>
        </div>
        {providers.length === 0 ? (
          <span className="text-xs text-foreground-muted">
            {isError
              ? 'Kullanım verisine ulaşılamadı.'
              : isLoading
                ? 'Hesap verileri sorgulanıyor…'
                : 'Okunabilir abonelik verisi yok.'}
          </span>
        ) : (
          providers.map((usage) => (
            <ProviderUsageDetails
              key={usage.providerId}
              providerId={usage.providerId}
              usage={usage}
              now={now}
            />
          ))
        )}
        <span className="border-t border-border pt-2 text-[11px] text-foreground-muted">
          Bu Mac’teki ajan oturumlarından okunur, 3 dakikada bir yenilenir. Bir penceresi %90’ın
          üzerinde dolu olan ajanı Orkestra şefi, başka seçenek varken işçi olarak seçmez.
        </span>
      </Popover.Content>
    </Popover.Root>
  );
}
