import type { UsageCapacityStatus } from '@core/features/usage-limits/api/usage-capacity';
import type {
  ProviderUsage,
  UsageResetCredit,
} from '@core/features/usage-limits/api/usage-limits';

/** Kullanım göstergesinin Türkçe metin ve renk yardımcıları. */

const PROVIDER_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  glm: 'GLM / Z.ai',
  grok: 'Grok',
  antigravity: 'Antigravity',
};

export function usageProviderName(providerId: string): string {
  return PROVIDER_NAMES[providerId] ?? providerId;
}

/** Süreyi kısa Türkçe biçimde yazar: "45 dk", "2 sa 15 dk", "3 gün 4 sa". */
export function formatUsageDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '1 dk’dan az';
  if (minutes < 60) return `${minutes} dk`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest ? `${hours} sa ${rest} dk` : `${hours} sa`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} gün ${rest} sa` : `${days} gün`;
}

function timeOf(iso: string | undefined): number | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  return Number.isFinite(time) ? time : null;
}

/** "3 gün 4 sa sonra yenilenir"; zamanı geçmişse yenilendiğini söyler; bilinmiyorsa null. */
export function formatResetsIn(resetsAt: string | undefined, now: number): string | null {
  const time = timeOf(resetsAt);
  if (time === null) return null;
  if (time <= now) return 'Yenilendi, yeni ölçüm bekleniyor';
  return `${formatUsageDuration(time - now)} sonra yenilenir`;
}

/** "az önce", "12 dk önce", "3 sa önce". */
export function formatMeasuredAgo(iso: string | undefined, now: number): string | null {
  const time = timeOf(iso);
  if (time === null) return null;
  if (now - time < 60_000) return 'az önce';
  return `${formatUsageDuration(now - time)} önce`;
}

export function formatUsagePercent(value: number): string {
  return `%${Math.round(value)}`;
}

/** Durum → metin rengi sınıfı. */
export function usageToneClass(status: UsageCapacityStatus): string {
  switch (status) {
    case 'saturated':
      return 'text-foreground-destructive';
    case 'tight':
      return 'text-amber-500';
    case 'ok':
      return 'text-emerald-500';
    case 'unknown':
      return 'text-foreground-muted';
  }
}

/** Kullanılan yüzdeye göre ilerleme çubuğu dolgu sınıfı. */
export function usageBarClass(usedPercent: number): string {
  if (usedPercent >= 90) return 'bg-destructive';
  if (usedPercent >= 70) return 'bg-amber-500';
  return 'bg-emerald-500';
}

/**
 * Sıfırlama hakkının son kullanma tarihini Türkçe ve kalan süreyle biçimlendirir:
 * ör. "27 Ara 2026 (30 gün kaldı)". Geçmişse "Süresi doldu", bilinmiyorsa null döner.
 */
export function formatResetCreditExpiry(
  expiresAt: string | undefined,
  now: number
): string | null {
  const time = timeOf(expiresAt);
  if (time === null) return null;
  if (time <= now) return 'Süresi doldu';
  let formattedDate: string;
  try {
    formattedDate = new Date(time).toLocaleDateString('tr-TR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    formattedDate = new Date(time).toISOString().slice(0, 10);
  }
  return `${formattedDate} (${formatUsageDuration(time - now)} kaldı)`;
}

export type ActiveResetCreditsSummary = {
  count: number;
  canRedeem: boolean;
  credits: UsageResetCredit[];
  nextExpiring: UsageResetCredit | null;
};

/**
 * Sağlayıcının kullanılabilir (tüketilmemiş ve süresi dolmamış) sıfırlama haklarını ve en yakın
 * son kullanma tarihli hakkı döndürür.
 */
export function getActiveResetCredits(
  usage: ProviderUsage | null | undefined,
  now: number
): ActiveResetCreditsSummary {
  const raw = usage?.resetCredits;
  if (!raw || raw.availableCount <= 0) {
    return { count: 0, canRedeem: false, credits: [], nextExpiring: null };
  }
  const active = raw.credits
    .filter((credit) => {
      if (credit.status === 'redeemed') return false;
      const exp = timeOf(credit.expiresAt);
      if (exp !== null && exp <= now) return false;
      return true;
    })
    .sort((a, b) => {
      const ta = timeOf(a.expiresAt) ?? Number.POSITIVE_INFINITY;
      const tb = timeOf(b.expiresAt) ?? Number.POSITIVE_INFINITY;
      return ta - tb;
    });
  // Detay satırları geldiyse ama hepsi süresi dolmuşsa artık kullanılabilir hak kalmamıştır.
  const count = raw.credits.length > 0 && active.length === 0 ? 0 : raw.availableCount;
  return {
    count,
    canRedeem: count > 0 && raw.canRedeem !== false,
    credits: active,
    nextExpiring: active[0] ?? null,
  };
}
