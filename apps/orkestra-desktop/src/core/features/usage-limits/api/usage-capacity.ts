import type { ProviderUsage, UsageWindow } from './usage-limits';

/**
 * Kullanım pencerelerinden "kalan kapasite" kararı. Hem gösterge renkleri hem de Orkestra'nın
 * ajan seçimi bu kuralları kullanır.
 *
 * - Yenilenme zamanı geçmiş pencere artık geçerli değildir ve yok sayılır.
 * - Bir pencere içinde kullanım yalnızca artar; bu yüzden eski bir ölçüm bile pencere
 *   yenilenmediği sürece doluluğu kanıtlar ("saturated"). Eski bir düşük ölçüm ise boşluğu
 *   kanıtlamaz: durum "unknown" olur.
 * - Veri yoksa ya da okunamıyorsa durum "unknown"dur; tüketiciler bugünkü davranışı korur.
 */

/** Bu yüzde ve üstündeki pencere dolu sayılır; Orkestra başka seçenek varken bu ajanı seçmez. */
export const USAGE_SATURATION_PERCENT = 90;
/** Göstergede uyarı rengi eşiği. */
export const USAGE_WARNING_PERCENT = 70;
/** Bundan eski ölçüm, boşluk kanıtı olarak kullanılmaz. */
export const USAGE_MAX_AGE_MS = 45 * 60_000;

export type UsageCapacityStatus = 'unknown' | 'ok' | 'tight' | 'saturated';

export type UsageCapacity = {
  status: UsageCapacityStatus;
  /** En dolu geçerli pencere (bağlayıcı pencere); bilinmiyorsa null. */
  window: UsageWindow | null;
  /** Ölçüm eski: yalnızca doluluk kanıtı olarak kullanıldı. */
  stale: boolean;
};

function timeOf(value: string | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/** Yenilenme zamanı henüz gelmemiş (ya da bilinmeyen) pencereler. */
export function activeUsageWindows(usage: ProviderUsage, now: number): UsageWindow[] {
  return usage.windows.filter((window) => {
    const reset = timeOf(window.resetsAt);
    return reset === null || reset > now;
  });
}

export function isUsageMeasurementStale(usage: ProviderUsage, now: number): boolean {
  const measured = timeOf(usage.measuredAt);
  return measured === null || measured > now + 60_000 || now - measured > USAGE_MAX_AGE_MS;
}

export function evaluateUsageCapacity(
  usage: ProviderUsage | null | undefined,
  now: number
): UsageCapacity {
  if (!usage) return { status: 'unknown', window: null, stale: false };
  const windows = activeUsageWindows(usage, now);
  const stale = isUsageMeasurementStale(usage, now);
  const binding = windows.reduce<UsageWindow | null>(
    (worst, window) => (!worst || window.usedPercent > worst.usedPercent ? window : worst),
    null
  );
  if (!binding) return { status: 'unknown', window: null, stale };
  if (binding.usedPercent >= USAGE_SATURATION_PERCENT) {
    return { status: 'saturated', window: binding, stale };
  }
  if (stale) return { status: 'unknown', window: binding, stale };
  return {
    status: binding.usedPercent >= USAGE_WARNING_PERCENT ? 'tight' : 'ok',
    window: binding,
    stale,
  };
}
