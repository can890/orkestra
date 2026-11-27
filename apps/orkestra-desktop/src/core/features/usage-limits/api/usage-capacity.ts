import type { ProviderUsage, UsageSnapshot, UsageWindow } from './usage-limits';

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
/** Limit bitmek üzereyken sıfırlama hakkı önerisinin çıkacağı kullanım yüzdesi eşiği. */
export const USAGE_RESET_PROMPT_PERCENT = 80;
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

/** Sağlayıcı kimliği → kapasite; ölçümü olmayan sağlayıcı haritada yer almaz (yani "unknown"). */
export type ProviderCapacities = Record<string, UsageCapacity>;

/** Bir anlık görüntüdeki her sağlayıcı için kapasiteyi değerlendirir. */
export function evaluateProviderCapacities(
  snapshot: UsageSnapshot | null | undefined,
  now: number
): ProviderCapacities {
  const result: ProviderCapacities = {};
  for (const usage of snapshot?.providers ?? []) {
    result[usage.providerId] = evaluateUsageCapacity(usage, now);
  }
  return result;
}

const RESET_PROMPT_BUCKET_MS = 30 * 60_000;

export type ResetCreditPromptDecision =
  | { show: false }
  | {
      show: true;
      reason: 'approaching' | 'saturated' | 'turn-error';
      usedPercent: number | null;
      resetsAt: string | undefined;
      availableCount: number;
      nextCreditId: string | undefined;
      nextExpiresAt: string | undefined;
      /** Kapatma kaydı için kararlı anahtar (aynı pencere yenilenene kadar). */
      dismissKey: string;
    };

/**
 * Aktif sağlayıcının kullanılabilir sıfırlama hakkı varsa ve kullanım limiti bitmek üzereyse
 * (>= %80), dolduysa (>= %90) veya son tur limit hatasıyla bittiyse kullanıcıya sıfırlama
 * hakkını kullanmasını öneren saf karar fonksiyonu.
 */
export function decideResetCreditPrompt(input: {
  usage: ProviderUsage | null | undefined;
  limitErrorTurnId?: string | null | undefined;
  now: number;
  thresholdPercent?: number;
}): ResetCreditPromptDecision {
  const { usage, limitErrorTurnId, now } = input;
  const threshold = input.thresholdPercent ?? USAGE_RESET_PROMPT_PERCENT;
  const raw = usage?.resetCredits;
  if (!usage || !raw || raw.availableCount <= 0 || raw.canRedeem === false) {
    return { show: false };
  }
  const activeCredits = raw.credits
    .filter((credit) => {
      if (credit.status === 'redeemed') return false;
      const exp = timeOf(credit.expiresAt);
      return exp === null || exp > now;
    })
    .sort((a, b) => {
      const ta = timeOf(a.expiresAt) ?? Number.POSITIVE_INFINITY;
      const tb = timeOf(b.expiresAt) ?? Number.POSITIVE_INFINITY;
      return ta - tb;
    });
  if (raw.credits.length > 0 && activeCredits.length === 0) {
    return { show: false };
  }
  const capacity = evaluateUsageCapacity(usage, now);
  const usedPercent = capacity.window ? capacity.window.usedPercent : null;
  const resetsAt = capacity.window?.resetsAt;

  let reason: 'approaching' | 'saturated' | 'turn-error' | null = null;
  if (limitErrorTurnId) {
    reason = 'turn-error';
  } else if (capacity.status === 'saturated') {
    reason = 'saturated';
  } else if (!capacity.stale && usedPercent !== null && usedPercent >= threshold) {
    reason = 'approaching';
  }

  if (!reason) return { show: false };

  const resetMs = timeOf(resetsAt);
  const bucket =
    resetMs !== null ? String(Math.round(resetMs / RESET_PROMPT_BUCKET_MS)) : 'unknown';
  const dismissKey =
    reason === 'turn-error' && limitErrorTurnId
      ? `reset-credit:turn-error:${limitErrorTurnId}`
      : `reset-credit:${usage.providerId}:${reason}:${bucket}`;

  return {
    show: true,
    reason,
    usedPercent,
    resetsAt,
    availableCount: raw.availableCount,
    nextCreditId: activeCredits[0]?.id,
    nextExpiresAt: activeCredits[0]?.expiresAt,
    dismissKey,
  };
}
