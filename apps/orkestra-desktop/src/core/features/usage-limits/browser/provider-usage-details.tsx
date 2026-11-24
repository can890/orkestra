import { Badge } from '@orkestra/ui/react/primitives';
import {
  activeUsageWindows,
  evaluateUsageCapacity,
} from '@core/features/usage-limits/api/usage-capacity';
import type { ProviderUsage, UsageWindow } from '@core/features/usage-limits/api/usage-limits';
import { cn } from '@core/primitives/styling/browser/cn';
import {
  formatMeasuredAgo,
  formatResetsIn,
  formatUsagePercent,
  usageBarClass,
  usageProviderName,
  usageToneClass,
} from './usage-format';

const STATUS_TEXT: Record<Exclude<ProviderUsage['status'], 'available'>, string> = {
  'auth-required': 'Hesap erişimi gerekli',
  unavailable: 'Bu makinede kullanılamıyor',
  error: 'Veri alınamıyor',
};

const numberFormat = (value: number) => value.toLocaleString('tr-TR', { maximumFractionDigits: 2 });

function compactResetText(reset: string | null): string | null {
  if (!reset) return null;
  if (reset.endsWith(' sonra yenilenir')) {
    return reset.slice(0, -' sonra yenilenir'.length);
  }
  if (reset.startsWith('Yenilendi')) {
    return 'Yenilendi';
  }
  return reset;
}

function UsageWindowRow({
  providerId,
  window,
  now,
  compact = false,
}: {
  providerId: string;
  window: UsageWindow;
  now: number;
  compact?: boolean;
}) {
  const reset = formatResetsIn(window.resetsAt, now);
  const compactReset = compact ? compactResetText(reset) : null;
  const resetTime = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  // Yenilenmiş pencerenin yüzdesi eski döneme aittir; soluk gösterilir.
  const expired = Number.isFinite(resetTime) && resetTime <= now;
  if (compact) {
    return (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-foreground">{window.label}</span>
            {compactReset && (
              <span className="shrink-0 text-[10.5px] text-foreground-muted">
                · {compactReset}
              </span>
            )}
          </span>
          <span
            className={cn(
              'shrink-0 font-medium tabular-nums',
              expired ? 'text-foreground-muted' : 'text-foreground'
            )}
          >
            {formatUsagePercent(window.usedPercent)}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={`${usageProviderName(providerId)} ${window.label} kullanımı`}
          aria-valuenow={Math.round(window.usedPercent)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-1 overflow-hidden rounded-full bg-background-tertiary-2"
        >
          <div
            className={cn(
              'h-full',
              expired ? 'bg-foreground-muted' : usageBarClass(window.usedPercent)
            )}
            style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-foreground">{window.label}</span>
        <span
          className={cn(
            'shrink-0 font-medium tabular-nums',
            expired ? 'text-foreground-muted' : 'text-foreground'
          )}
        >
          {formatUsagePercent(window.usedPercent)} kullanıldı
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${usageProviderName(providerId)} ${window.label} kullanımı`}
        aria-valuenow={Math.round(window.usedPercent)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 overflow-hidden rounded-full bg-background-tertiary-2"
      >
        <div
          className={cn(
            'h-full',
            expired ? 'bg-foreground-muted' : usageBarClass(window.usedPercent)
          )}
          style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
        />
      </div>
      {reset && <span className="text-[11px] text-foreground-muted">{reset}</span>}
    </div>
  );
}

/** Bir sağlayıcının abonelik pencereleri, planı, bakiyeleri ve veri kaynağı. */
export function ProviderUsageDetails({
  providerId,
  usage,
  now,
  isLoading = false,
  isError = false,
  showBalances = false,
  compact = false,
}: {
  providerId: string;
  usage: ProviderUsage | null;
  now: number;
  isLoading?: boolean;
  isError?: boolean;
  showBalances?: boolean;
  compact?: boolean;
}) {
  const capacity = evaluateUsageCapacity(usage, now);
  const measured = usage ? formatMeasuredAgo(usage.measuredAt, now) : null;
  const active = usage ? activeUsageWindows(usage, now) : [];
  // Etkin pencereler önce, yenilenmiş (eski döneme ait) pencereler sonra.
  const windows = usage
    ? [...active, ...usage.windows.filter((window) => !active.includes(window))]
    : [];
  return (
    <div className={cn('flex flex-col', compact ? 'gap-1.5' : 'gap-2')}>
      <div className="flex items-center justify-between gap-2">
        <span className={cn('text-foreground', compact ? 'text-xs font-semibold' : 'text-sm font-medium')}>
          {usageProviderName(providerId)}
        </span>
        <span className="flex items-center gap-1.5">
          {usage?.plan && <Badge variant="outline">{usage.plan}</Badge>}
          {capacity.window && (
            <span
              className={cn('text-xs font-medium tabular-nums', usageToneClass(capacity.status))}
            >
              {formatUsagePercent(capacity.window.usedPercent)}
            </span>
          )}
        </span>
      </div>
      {!compact && usage?.account && (
        <span className="text-xs break-all text-foreground-muted">{usage.account}</span>
      )}
      {!usage ? (
        <span className="text-xs text-foreground-muted">
          {isError
            ? 'Kullanım verisine ulaşılamadı. Makine bağlantısını kontrol edin.'
            : isLoading
              ? 'Hesap verisi sorgulanıyor…'
              : 'Veri yok.'}
        </span>
      ) : (
        <>
          {usage.status !== 'available' && windows.length === 0 && (
            <span className="text-xs font-medium text-foreground">{STATUS_TEXT[usage.status]}</span>
          )}
          {windows.map((window, index) => (
            <UsageWindowRow
              key={`${window.label}-${index}`}
              providerId={providerId}
              window={window}
              now={now}
              compact={compact}
            />
          ))}
          {showBalances &&
            usage.balances.map((balance, index) => (
              <div key={index} className="flex justify-between gap-2 text-xs">
                <span>{balance.label}</span>
                <strong>
                  {numberFormat(balance.value)} {balance.unit}
                </strong>
              </div>
            ))}
          {usage.refreshError && (
            <span className="text-xs text-amber-500">
              Son yenileme başarısız: {usage.refreshError} Önceki ölçüm gösteriliyor.
            </span>
          )}
          {(!compact || usage.status !== 'available') && usage.message && (
            <span className="text-xs text-foreground-muted">{usage.message}</span>
          )}
          {capacity.stale && windows.length > 0 && (
            <span className="text-xs text-amber-500">
              Ölçüm eski; güncel kullanım daha yüksek olabilir.
            </span>
          )}
          {!compact && (
            <span className="text-[11px] text-foreground-muted">
              {usage.source}
              {measured ? ` · ölçüm ${measured}` : ''}
            </span>
          )}
        </>
      )}
    </div>
  );
}
