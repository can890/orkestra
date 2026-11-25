import type { PromptPlacement } from '@orkestra/core/runtimes/acp/api/client';

/**
 * Mesaj kutusu hiçbir ajan durumunda kilitlenmez: yazmak her zaman serbesttir, Enter her zaman
 * bir sonuç üretir. Bu dosya, gönderimin o anki bağlantı durumuna göre nereye gideceğini seçen
 * saf kuralları tutar (deposuz test edilebilsin diye).
 */

export type ComposerSubmitRoute =
  /** Canlı oturum hazır: mesaj hemen gönderilir (ajan çalışıyorsa yönlendirme ya da sıra). */
  | { kind: 'send' }
  /** Oturum bağlanıyor ya da yeniden bağlanıyor: bağlantı gelince aynı mesaj gönderilir. */
  | { kind: 'wait' }
  /** Şu an iletilemez (proje erişimi yok, oturum kayıp): metin taslakta kalır, neden gösterilir. */
  | { kind: 'hold'; reason: string };

export type ComposerSubmitInput = {
  /** Proje sunucusuna erişim kapalı (uzak makine çevrimdışı, proje erişimi yok). */
  hostDisabled: boolean;
  hasSession: boolean;
  sessionUsable: boolean;
  /** İlk bağlanma sürüyor (oturum ya da geçmiş yükleniyor). */
  connecting: boolean;
  loadError: { kind: string; message: string } | null;
};

export const HOLD_REASON_HOST =
  'Proje erişimi yok; mesajınız taslakta duruyor, erişim dönünce gönderebilirsiniz.';
export const HOLD_REASON_SESSION =
  'Sohbet oturumuna bağlanılamadı; mesajınız taslakta duruyor. Yukarıdaki "Tekrar Dene" ile yeniden bağlanın.';
export const HOLD_REASON_TIMEOUT =
  'Bağlantı kurulamadı; mesajınız taslakta duruyor, bağlantı dönünce yeniden gönderin.';

/** Bağlantı beklenirken gönderimin en çok ne kadar bekleyeceği (sonra taslağa döner). */
export const SUBMIT_CONNECTION_WAIT_MS = 45_000;

export function composerSubmitRoute(input: ComposerSubmitInput): ComposerSubmitRoute {
  if (input.hostDisabled) return { kind: 'hold', reason: HOLD_REASON_HOST };
  if (input.hasSession && input.sessionUsable) return { kind: 'send' };
  if (input.loadError) return { kind: 'hold', reason: HOLD_REASON_SESSION };
  // Oturum var ama yeniden doğrulanıyor ya da ilk bağlantı sürüyor: kısa bir kopukluk.
  if (input.hasSession || input.connecting) return { kind: 'wait' };
  return { kind: 'hold', reason: HOLD_REASON_SESSION };
}

/**
 * Ajan çalışırken gönderilen mesajın yerleşimi. Canlı yönlendirmeyi yalnızca bunu bildiren ajana
 * isteriz; diğerlerinde mesaj sıraya girer ve tur bitince kendiliğinden gönderilir. Eski bir
 * çalışma alanı sunucusu da yönlendiremeyen ajanın turunu bu sayede asla durdurmaz.
 */
export function workingTurnPlacement(
  mode: 'queue' | 'steer-cancel',
  supportsSteering: boolean
): Extract<PromptPlacement, 'steer' | 'queue'> {
  return mode === 'steer-cancel' && supportsSteering ? 'steer' : 'queue';
}
