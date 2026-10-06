import type { WebContents } from 'electron';

/**
 * Ajanın gönderdiği sentetik giriş olaylarını işaretler.
 *
 * `webContents.sendInputEvent` klavye olayları için `before-input-event`'i eşzamanlı olarak
 * tetikler; sağ tık sonrası `context-menu` ise biraz sonra gelir. Uygulama kısayollarını ya da
 * bağlam menüsünü işleyen kod (tarayıcı WebContents kayıt defteri) bu girişleri
 * `isAutomationInputActive` ile ayırt edip yok saymalıdır; aksi halde ajanın "Control+Tab"
 * tuşu uygulamanın sekmesini değiştirir ya da sağ tık kullanıcının ekranında menü açar.
 */

type Marker = { depth: number; until: number };

const markers = new WeakMap<WebContents, Marker>();

export function isAutomationInputActive(
  webContents: WebContents,
  now: number = Date.now()
): boolean {
  const marker = markers.get(webContents);
  if (!marker) return false;
  return marker.depth > 0 || now < marker.until;
}

/** `action` süresince ve ardından `graceMs` boyunca girişi ajan girişi olarak işaretler. */
export function runAsAutomationInput<T>(
  webContents: WebContents,
  action: () => T,
  graceMs: number = 0
): T {
  const marker = markers.get(webContents) ?? { depth: 0, until: 0 };
  markers.set(webContents, marker);
  marker.depth += 1;
  try {
    return action();
  } finally {
    marker.depth -= 1;
    marker.until = Math.max(marker.until, Date.now() + Math.max(0, graceMs));
  }
}
