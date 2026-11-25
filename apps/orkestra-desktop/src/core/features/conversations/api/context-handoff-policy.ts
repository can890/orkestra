/**
 * Bağlam devri ("Sohbeti yeni bağlama taşı") için saf karar kuralları: öneri şeridinin ne zaman
 * görüneceği, kapatma adımları ve mesaj kutusunun üstündeki şeritlerin üst üste binme kuralı.
 * G/Ç yok, saat yok; yalnızca girdiye bakar.
 */

/** Öneri şeridinin varsayılan eşiği (bağlam doluluğu, yüzde). */
export const DEFAULT_CONTEXT_HANDOFF_THRESHOLD = 85;
/** Daha güçlü ifadenin kullanıldığı ikinci adım (yüzde). */
export const CRITICAL_CONTEXT_HANDOFF_THRESHOLD = 95;
/** Ayarlarda izin verilen eşik aralığı (yüzde). */
export const MIN_CONTEXT_HANDOFF_THRESHOLD = 50;
export const MAX_CONTEXT_HANDOFF_THRESHOLD = 95;
/**
 * Doluluk eşiğin bu kadar puan altına inerse (ör. /compact sonrası) kapatma kayıtları sıfırlanır;
 * bağlam yeniden dolunca şerit yeniden önerilebilir.
 */
export const DISMISSAL_RESET_MARGIN = 10;
/**
 * Bildirilen kullanım pencerenin bu katını aşıyorsa sayı güvenilmez kabul edilir (sağlayıcının
 * farklı birimle ya da birikimli toplamla bildirdiği durumlar). Şerit yanlış alarm vermesin.
 */
const IMPLAUSIBLE_USAGE_FACTOR = 1.5;

export type ContextHandoffStep = 'warn' | 'critical';
/** Kapatılabilen şerit adımları: iki öneri adımı ve "taşındı" bildirimi. */
export type ContextHandoffDismissal = ContextHandoffStep | 'moved';

export type ContextUsageLike = { used: number; size: number } | null | undefined;

/** Eşiği izin verilen aralığa sıkıştırır; geçersiz değerde varsayılanı döndürür. */
export function clampContextHandoffThreshold(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CONTEXT_HANDOFF_THRESHOLD;
  }
  return Math.min(
    MAX_CONTEXT_HANDOFF_THRESHOLD,
    Math.max(MIN_CONTEXT_HANDOFF_THRESHOLD, Math.round(value))
  );
}

/**
 * Bağlam doluluğu (0..1,5); sağlayıcı kullanım bildirmiyorsa ya da sayı anlamsızsa `null`.
 */
export function contextUsageRatio(usage: ContextUsageLike): number | null {
  if (!usage || !Number.isFinite(usage.size) || usage.size <= 0) return null;
  if (!Number.isFinite(usage.used) || usage.used < 0) return null;
  const ratio = usage.used / usage.size;
  return ratio > IMPLAUSIBLE_USAGE_FACTOR ? null : ratio;
}

/** Ekranda gösterilecek yüzde (0..100, tam sayı). */
export function contextUsagePercent(ratio: number): number {
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

/**
 * Doluluğun düştüğü adım. Eşik 95 ve üstündeyse tek adım vardır (`critical`); aksi halde eşikte
 * `warn`, %95'te `critical`.
 */
export function contextHandoffStep(
  ratio: number | null,
  thresholdPercent: number
): ContextHandoffStep | null {
  if (ratio === null) return null;
  const threshold = clampContextHandoffThreshold(thresholdPercent);
  const percent = ratio * 100;
  if (percent >= Math.max(threshold, CRITICAL_CONTEXT_HANDOFF_THRESHOLD)) return 'critical';
  if (percent >= threshold) {
    return threshold >= CRITICAL_CONTEXT_HANDOFF_THRESHOLD ? 'critical' : 'warn';
  }
  return null;
}

export type ContextHandoffBannerInput = {
  /** Ayar: öneri şeridi açık mı. */
  enabled: boolean;
  thresholdPercent: number;
  usage: ContextUsageLike;
  /**
   * Kullanım sayısı güncel mi: oturum bağlı ve kullanılabilir, geçmiş yüklenmiş. Yeniden bağlanma
   * ya da yükleme sırasında eski oturumdan kalan sayı gösterilmez.
   */
  usageFresh: boolean;
  /** Bu sohbette kapatılmış adımlar. */
  dismissed: readonly ContextHandoffDismissal[];
  /** Sohbette en az bir mesaj var mı (boş sohbette önerilmez). */
  hasMessages: boolean;
  /** Bu sohbet zaten bir halefe taşındı mı (taşındıysa bir daha önerilmez). */
  hasSuccessor: boolean;
  /** Bu sohbet için bir taşıma şu an sürüyor mu. */
  inFlight: boolean;
};

export type ContextHandoffBannerDecision =
  | { show: false }
  | { show: true; step: ContextHandoffStep; percent: number };

/**
 * Öneri şeridinin kararı. Kapatma adım başınadır: `warn` kapatılmışsa şerit `critical` adımında
 * yeniden çıkar; `critical` kapatılmışsa (doluluk düşüp sıfırlanana kadar) bir daha çıkmaz.
 */
export function decideContextHandoffBanner(
  input: ContextHandoffBannerInput
): ContextHandoffBannerDecision {
  if (!input.enabled || !input.hasMessages || input.hasSuccessor || input.inFlight) {
    return { show: false };
  }
  if (!input.usageFresh) return { show: false };
  const ratio = contextUsageRatio(input.usage);
  const step = contextHandoffStep(ratio, input.thresholdPercent);
  if (ratio === null || step === null) return { show: false };
  if (input.dismissed.includes('critical')) return { show: false };
  if (input.dismissed.includes(step)) return { show: false };
  return { show: true, step, percent: contextUsagePercent(ratio) };
}

/**
 * Bağlam devri özelliği açıkken ve doluluk eşiği geçmişken "bağlam dolu" konusu devir şeridine
 * aittir: /compact şeridi aynı konuyu ikinci kez söylemesin (kapatılmış olsa bile). Sohbet zaten
 * taşındıysa /compact şeridi eski kuralıyla çalışır.
 */
export function contextHandoffOwnsContextWarning(input: {
  enabled: boolean;
  thresholdPercent: number;
  usage: ContextUsageLike;
  hasSuccessor: boolean;
}): boolean {
  if (!input.enabled || input.hasSuccessor) return false;
  return contextHandoffStep(contextUsageRatio(input.usage), input.thresholdPercent) !== null;
}

/**
 * Doluluk belirgin biçimde düştüyse (ör. bağlam sıkıştırıldı) öneri adımlarının kapatma kayıtlarını
 * sıfırlar; "taşındı" kaydı korunur. Değişiklik yoksa aynı diziyi döndürür (çağıran gereksiz
 * yazmayı atlayabilsin).
 */
export function reconcileContextHandoffDismissals(
  dismissed: readonly ContextHandoffDismissal[],
  usage: ContextUsageLike,
  thresholdPercent: number
): readonly ContextHandoffDismissal[] {
  if (!dismissed.some((entry) => entry !== 'moved')) return dismissed;
  const ratio = contextUsageRatio(usage);
  if (ratio === null) return dismissed;
  const threshold = clampContextHandoffThreshold(thresholdPercent);
  if (ratio * 100 >= threshold - DISMISSAL_RESET_MARGIN) return dismissed;
  return dismissed.filter((entry) => entry === 'moved');
}

export type ComposerBannerSignals = {
  /** Kullanım limiti şeridi (sağlayıcı limiti doldu). */
  limit: boolean;
  /** Bağlam devri sürüyor (kullanıcı tıkladı; geri bildirim şeridi). */
  handoffInFlight: boolean;
  /** Bağlam devri öneri şeridi kurallara göre görünür olurdu. */
  handoffSuggestion: boolean;
  /** "Bu sohbet şuraya taşındı" şeridi görünür olurdu. */
  handoffMoved: boolean;
};

export type ComposerBannerLayout = {
  limit: boolean;
  handoff: 'in-flight' | 'suggestion' | 'moved' | null;
};

/**
 * Mesaj kutusunun üstündeki şeritlerin üst üste binme kuralı (duvar oluşmasın):
 *
 * 1. Kullanıcının başlattığı taşımanın durum şeridi her zaman gösterilir (eyleminin geri
 *    bildirimi) ve diğer devir şeritlerinin yerini alır.
 * 2. Limit şeridi olduğu gibi gösterilir (işin kendisini durduran sorun); o varken taşıma önerisi
 *    ve "taşındı" bildirimi gizlenir: limit şeridi zaten başka ajana geçmeyi önerir.
 * 3. Öneri, "taşındı" bildiriminden önce gelir (ikisi aynı anda zaten oluşmaz: taşınan sohbete
 *    öneri yapılmaz).
 * 4. /compact şeridi bağlam doluyken devir şeridine yer bırakır
 *    (`contextHandoffOwnsContextWarning`); bileşen bunu kendisi uygular.
 *
 * Böylece mesaj kutusunun üstünde devir ailesinden en fazla bir şerit, limitle birlikte en fazla
 * iki şerit görünür.
 */
export function arrangeComposerBanners(signals: ComposerBannerSignals): ComposerBannerLayout {
  let handoff: ComposerBannerLayout['handoff'] = null;
  if (signals.handoffInFlight) handoff = 'in-flight';
  else if (!signals.limit && signals.handoffSuggestion) handoff = 'suggestion';
  else if (!signals.limit && signals.handoffMoved) handoff = 'moved';
  return { limit: signals.limit, handoff };
}
