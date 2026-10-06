import type { LogHealthGroup } from './contract';

/** Bir grubun dikkat göstergesini tetiklemesi için gereken tekrar sayısı. */
export const LOG_HEALTH_ATTENTION_THRESHOLD = 3;

/** Kullanıcının yok saydığı ve gördüğü gruplar (anahtar → zaman damgası, ms). */
export type LogHealthPreferences = {
  ignored: Readonly<Record<string, number>>;
  acknowledged: Readonly<Record<string, number>>;
};

/**
 * Grup göstergeyi (rozet/bildirim) tetiklemeli mi?
 * - Yok sayılan gruplar asla tetiklemez.
 * - Hiç görülmemiş bir grup; bu oturumda ≥3 kez, ≥3 farklı açılışta veya ≥3 farklı
 *   günde tekrarladıysa tetikler (açılışta bir kez düşen sessiz uyarılar dahil).
 * - Görülmüş (onaylanmış) bir grup ancak onaydan sonra başlayan bir oturumda
 *   yeniden ≥3 kez tekrarlarsa tetikler.
 */
export function needsAttention(
  group: LogHealthGroup,
  preferences: LogHealthPreferences,
  sessionStartedAt: number
): boolean {
  if (preferences.ignored[group.key] !== undefined) return false;
  const threshold = LOG_HEALTH_ATTENTION_THRESHOLD;
  const acknowledgedAt = preferences.acknowledged[group.key];
  if (acknowledgedAt === undefined) {
    return (
      group.sessionCount >= threshold ||
      group.launchCount >= threshold ||
      group.dayCount >= threshold
    );
  }
  return acknowledgedAt < sessionStartedAt && group.sessionCount >= threshold;
}

/** Kayıt sayısını sınırlar: en eski zaman damgalı anahtarlar düşer. */
export function boundPreferenceMap(
  map: Readonly<Record<string, number>>,
  maxEntries: number
): Record<string, number> {
  const entries = Object.entries(map);
  if (entries.length <= maxEntries) return { ...map };
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, maxEntries));
}
