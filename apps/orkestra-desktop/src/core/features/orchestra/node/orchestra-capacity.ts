import {
  activeUsageWindows,
  evaluateUsageCapacity,
  USAGE_SATURATION_PERCENT,
  type UsageCapacity,
} from '@core/features/usage-limits/api/usage-capacity';
import type { ProviderUsage } from '@core/features/usage-limits/api/usage-limits';

/**
 * Şefin ajan seçiminde abonelik kapasitesi. Bir penceresi %90 ve üzerinde dolu olan ajan, işi
 * üstlenebilecek başka bir ajan varken işçi olarak başlatılmaz. Kullanım bilinmiyorsa ajan
 * kullanılabilir sayılır, yani bugünkü davranış korunur. Şefe giden metinler İngilizcedir.
 */

export type ProviderUsageMap = Readonly<Record<string, ProviderUsage | null | undefined>>;

export function agentCapacity(usage: ProviderUsageMap, providerId: string, now: number) {
  return evaluateUsageCapacity(usage[providerId], now);
}

export function isSaturated(capacity: UsageCapacity): boolean {
  return capacity.status === 'saturated';
}

function minutesUntil(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  return Number.isFinite(time) ? Math.max(0, Math.round((time - now) / 60_000)) : null;
}

/** `list_agents` çıktısındaki `capacity` alanı. */
export function describeCapacity(usage: ProviderUsage | null | undefined, now: number) {
  const capacity = evaluateUsageCapacity(usage, now);
  if (!usage || capacity.status === 'unknown') {
    return {
      status: 'unknown' as const,
      note: 'Subscription usage could not be read (or is outdated); treat this agent as available.',
    };
  }
  const binding = capacity.window;
  return {
    status: capacity.status,
    ...(usage.plan ? { plan: usage.plan } : {}),
    ...(binding
      ? {
          binding_window: binding.label,
          used_percent: Math.round(binding.usedPercent),
          resets_in_minutes: minutesUntil(binding.resetsAt, now),
        }
      : {}),
    windows: activeUsageWindows(usage, now).map((window) => ({
      name: window.label,
      used_percent: Math.round(window.usedPercent),
      resets_at: window.resetsAt ?? null,
    })),
    ...(capacity.stale ? { measurement: 'outdated, but the window has not reset yet' } : {}),
  };
}

function formatWait(minutes: number | null): string {
  if (minutes === null) return 'an unknown time';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days ${hours % 24} h`;
}

/** Dolu bir ajan için kısa açıklama: hangi pencere, ne kadar dolu, ne zaman yenileniyor. */
export function saturationSummary(agentName: string, capacity: UsageCapacity, now: number): string {
  const window = capacity.window;
  if (!window) return `${agentName} is out of subscription capacity.`;
  return `${agentName} has used ${Math.round(window.usedPercent)}% of its "${window.label}" subscription window (limit for new workers: ${USAGE_SATURATION_PERCENT}%; resets in ${formatWait(minutesUntil(window.resetsAt, now))}).`;
}
