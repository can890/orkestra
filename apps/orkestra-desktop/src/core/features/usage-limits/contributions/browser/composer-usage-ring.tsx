import type { HostRef } from '@orkestra/core/primitives/host/api';
import { Popover, Tooltip } from '@orkestra/ui/react/primitives';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import {
  activeUsageWindows,
  evaluateUsageCapacity,
} from '@core/features/usage-limits/api/usage-capacity';
import { INDICATOR_USAGE_PROVIDERS } from '@core/features/usage-limits/api/usage-limits';
import {
  formatResetsIn,
  formatUsagePercent,
  usageProviderName,
  usageToneClass,
} from '@core/features/usage-limits/browser/usage-format';
import {
  useMinuteClock,
  useUsageLimits,
} from '@core/features/usage-limits/browser/use-usage-limits';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { cn } from '@core/primitives/styling/browser/cn';

const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ringStrokeClass(usedPercent: number, stale: boolean): string {
  if (stale) return 'text-foreground-muted/70';
  if (usedPercent >= 90) return 'text-foreground-destructive';
  if (usedPercent >= 70) return 'text-amber-500';
  if (usedPercent > 0) return 'text-emerald-500';
  return 'text-foreground-muted/70';
}

function formatResetShort(iso: string | undefined, now: number): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  if (ms <= now) return formatResetsIn(iso, now);
  try {
    const weekday = new Date(ms).toLocaleDateString('tr-TR', { weekday: 'short' });
    const time = new Date(ms).toLocaleTimeString('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${weekday} ${time}`;
  } catch {
    return formatResetsIn(iso, now);
  }
}

/**
 * Mesaj yazma çubuğunun sağ kümesinde yalnızca aktif yapay zekanın kullanım halkasını gösterir.
 * Üzerine gelince o yapay zekanın limit penceresini ve `Tümünü gör` bağlantısını açar.
 */
export function ComposerUsageRing({
  providerId,
  host,
}: {
  providerId: string | null;
  host: HostRef;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const { navigate } = useNavigate();
  const now = useMinuteClock();
  const { snapshot } = useUsageLimits(host, INDICATOR_USAGE_PROVIDERS, {
    enabled: Boolean(providerId),
  });

  if (!providerId) return null;

  const usage = snapshot?.providers.find((item) => item.providerId === providerId) ?? null;
  if (!usage || (usage.windows.length === 0 && usage.balances.length === 0)) {
    return null;
  }

  const capacity = evaluateUsageCapacity(usage, now);
  const activeWindows = activeUsageWindows(usage, now);
  const windowsToShow = (activeWindows.length > 0 ? activeWindows : usage.windows).slice(0, 4);
  const primaryWindow = capacity.window ?? windowsToShow[0] ?? usage.windows[0] ?? null;
  const percent = primaryWindow ? Math.min(100, Math.max(0, primaryWindow.usedPercent)) : 0;
  const dashOffset = RING_CIRCUMFERENCE * (1 - percent / 100);
  const primaryResetShort = primaryWindow ? formatResetShort(primaryWindow.resetsAt, now) : null;

  const openAllLimits = () => {
    setPopoverOpen(false);
    setTooltipOpen(false);
    navigate(settingsViewDef({ tab: 'clis-models' }));
  };

  return (
    <Tooltip.Provider delay={150}>
      <Popover.Root
        open={popoverOpen}
        onOpenChange={(next) => {
          setPopoverOpen(next);
          if (next) setTooltipOpen(false);
        }}
      >
        <Tooltip.Root open={tooltipOpen && !popoverOpen} onOpenChange={setTooltipOpen}>
          <Tooltip.Trigger
            render={
              <Popover.Trigger
                render={
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-foreground-muted transition-colors outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2"
                    aria-label={`${usageProviderName(providerId)} limiti: ${primaryWindow ? formatUsagePercent(percent) : '–'}`}
                  />
                }
              />
            }
          >
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
              <circle
                cx="10"
                cy="10"
                r={RING_RADIUS}
                fill="none"
                stroke="currentColor"
                strokeWidth="2.1"
                className="text-foreground/[0.15]"
              />
              <circle
                cx="10"
                cy="10"
                r={RING_RADIUS}
                fill="none"
                stroke="currentColor"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={dashOffset}
                transform="rotate(-90 10 10)"
                className={ringStrokeClass(percent, capacity.stale)}
              />
            </svg>
          </Tooltip.Trigger>
          <Tooltip.Content
            side="top"
            align="end"
            sideOffset={8}
            showArrow={false}
            className="surface-elevated flex-col items-start gap-0.5 rounded-lg border border-border/80 !bg-(--em-surface) px-3 py-2 text-left !text-foreground shadow-lg"
          >
            <div className="whitespace-nowrap text-xs font-medium text-foreground">
              {primaryWindow
                ? `${primaryWindow.label}: ${formatUsagePercent(primaryWindow.usedPercent)}`
                : usageProviderName(providerId)}
            </div>
            {primaryResetShort && (
              <div className="whitespace-nowrap text-[11px] text-foreground-muted">
                Sıfırlanma: {primaryResetShort}
              </div>
            )}
          </Tooltip.Content>
        </Tooltip.Root>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={8}
          initialFocus={false}
          className="flex w-68 flex-col gap-2.5 p-3"
        >
          {windowsToShow.length > 0 ? (
            windowsToShow.map((win) => {
              const resetShort = formatResetShort(win.resetsAt, now);
              const winCapacity = evaluateUsageCapacity({ ...usage, windows: [win] }, now);
              return (
                <div key={win.label} className="flex flex-col gap-0.5">
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="truncate font-medium text-foreground">
                      {usageProviderName(providerId)} · {win.label}
                    </span>
                    <span
                      className={cn(
                        'shrink-0 font-semibold tabular-nums',
                        usageToneClass(winCapacity.status)
                      )}
                    >
                      {formatUsagePercent(win.usedPercent)}
                    </span>
                  </div>
                  {resetShort && (
                    <span className="text-[11px] text-foreground-muted">
                      Sıfırlanma: {resetShort}
                    </span>
                  )}
                </div>
              );
            })
          ) : (
            <div className="text-xs text-foreground">
              {usageProviderName(providerId)}: Bakiye / plan verisi mevcut
            </div>
          )}
          <div className="flex justify-end border-t border-border pt-2">
            <button
              type="button"
              onClick={openAllLimits}
              className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.06]"
            >
              <span>Tümünü gör</span>
              <ArrowRight className="h-3 w-3" />
            </button>
          </div>
        </Popover.Content>
      </Popover.Root>
    </Tooltip.Provider>
  );
}
