import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { Button, Popover } from '@orkestra/ui/react/primitives';
import { ArrowRight, Gauge } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import {
  INDICATOR_USAGE_PROVIDERS,
  PINNED_USAGE_PROVIDERS,
  type ProviderUsage,
} from '@core/features/usage-limits/api/usage-limits';
import { ProviderUsageDetails } from '@core/features/usage-limits/browser/provider-usage-details';
import {
  useMinuteClock,
  useUsageLimits,
} from '@core/features/usage-limits/browser/use-usage-limits';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';

/** Sabit sağlayıcılar her zaman, diğerleri yalnızca okunabilir pencereleri varsa görünür. */
function visibleProviders(providers: readonly ProviderUsage[]): ProviderUsage[] {
  return providers.filter(
    (usage) =>
      PINNED_USAGE_PROVIDERS.includes(usage.providerId) ||
      usage.windows.length > 0 ||
      usage.balances.length > 0
  );
}

/**
 * Kenar çubuğu altbilgisindeki kompakt abonelik limiti tetikleyicisi.
 * Normalde yalnızca `Limitler` etiketi görünür; tıklandığında tüm sağlayıcı limitleri açılır,
 * Ayarlar → CLI & Modeller sayfasına yalnızca açılır karttaki `Tümünü gör` bağlantısından gidilir.
 */
export function UsageLimitsIndicator({ trigger }: { trigger: ReactElement }) {
  const [open, setOpen] = useState(false);
  const { navigate } = useNavigate();
  const now = useMinuteClock();
  const { snapshot, isLoading, isError, isRefreshing, refresh } = useUsageLimits(
    LOCAL_HOST_REF,
    INDICATOR_USAGE_PROVIDERS
  );
  const providers = visibleProviders(snapshot?.providers ?? []);

  const openAllLimits = () => {
    setOpen(false);
    navigate(settingsViewDef({ tab: 'clis-models' }));
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={trigger} aria-label="Limitler">
        <span className="flex min-w-0 items-center gap-2">
          <Gauge className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
          <span className="truncate">Limitler</span>
        </span>
      </Popover.Trigger>
      <Popover.Content
        side="right"
        align="end"
        sideOffset={8}
        initialFocus={false}
        className="flex max-h-[82vh] w-[356px] flex-col overflow-hidden p-0"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <span className="text-sm font-semibold text-foreground">Limitler</span>
          <Button type="button" size="sm" variant="ghost" disabled={isRefreshing} onClick={refresh}>
            {isRefreshing ? 'Yenileniyor…' : 'Yenile'}
          </Button>
        </div>
        <div className="min-h-0 flex-1 divide-y divide-border/50 overflow-y-auto px-3 py-2">
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
              <div key={usage.providerId} className="py-2 first:pt-0.5 last:pb-0.5">
                <ProviderUsageDetails
                  providerId={usage.providerId}
                  usage={usage}
                  now={now}
                  compact
                />
              </div>
            ))
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
          <span className="text-[11px] text-foreground-muted">
            Oturumlardan okunur, 3 dk’da bir yenilenir.
          </span>
          <button
            type="button"
            onClick={openAllLimits}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.06]"
          >
            <span>Tümünü gör</span>
            <ArrowRight className="h-3 w-3" />
          </button>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
