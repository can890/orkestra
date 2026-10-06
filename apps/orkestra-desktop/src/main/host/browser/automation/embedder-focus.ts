import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { delay } from './timing';

/**
 * Güvenilir tıklama sonrası gömücü (embedder) odağını korur.
 *
 * Electron 40.10.2 üzerinde doğrulandı: misafire gönderilen her `mouseDown` (sendInputEvent ya
 * da CDP) Chromium'un FocusOwningWebContents davranışıyla gömücü sayfadaki odağı `<webview>`
 * öğesine taşır. Kullanıcı o sırada sohbet kutusuna yazıyorsa tuşları web sayfasına gider.
 * Klavye olayları, insertText, tekerlek, fare hareketi ve betikle `focus()` odağı taşımaz.
 *
 * Bu yüzden tıklamadan önce gömücüde odaklı öğe izole bir dünyada kaydedilir; tıklamadan sonra
 * odak bir `<webview>`'e geçtiyse önceki öğeye geri verilir. Misafirde odak öykünmesi
 * (Emulation.setFocusEmulationEnabled) açık olduğundan sayfa bu geri alımda blur/focusout
 * görmez; odaklı öğesi ve açık menüleri korunur (deneyle doğrulandı). Kullanıcı zaten bir
 * webview ile çalışıyorsa hiçbir şey yapılmaz.
 */

export const EMBEDDER_FOCUS_WORLD_ID = 31_338;
const RESTORE_POLL_DELAYS_MS = [0, 10, 25, 50, 100];

export type EmbedderFocusMemo = { host: WebContents; token: string };

// Gölge köklerinden geçerek odaklı öğeyi bulur. `<webview>` öğesinin kendi açık gölge kökü
// (içinde iç iframe) vardır; ona inilmez, webview'in kendisi döner.
const DEEP_ACTIVE_ELEMENT_SOURCE = `(root) => {
    let active = root.activeElement;
    while (active && active.tagName !== 'WEBVIEW' && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }`;

function captureScript(token: string): string {
  return `(() => {
  const deep = ${DEEP_ACTIVE_ELEMENT_SOURCE};
  const active = deep(document);
  if (active && active.tagName === 'WEBVIEW') return false;
  globalThis.__orkestraEmbedderFocus = { token: ${JSON.stringify(token)}, element: active };
  return true;
})()`;
}

function restoreScript(token: string): string {
  return `(() => {
  const memo = globalThis.__orkestraEmbedderFocus;
  if (!memo || memo.token !== ${JSON.stringify(token)}) return 'gone';
  const deep = ${DEEP_ACTIVE_ELEMENT_SOURCE};
  const active = deep(document);
  if (active === memo.element) return 'unchanged';
  globalThis.__orkestraEmbedderFocus = null;
  // Odak webview dışında başka bir yere geçtiyse kullanıcı taşımıştır; dokunma.
  if (!active || active.tagName !== 'WEBVIEW') return 'moved';
  const previous = memo.element;
  if (previous && previous.isConnected && previous !== document.body && typeof previous.focus === 'function') {
    previous.focus({ preventScroll: true });
  } else if (active && typeof active.blur === 'function') {
    active.blur();
  }
  return 'restored';
})()`;
}

/** Gömücüdeki odaklı öğeyi kaydeder; kullanıcı bir webview ile çalışıyorsa null döner. */
export async function captureEmbedderFocus(guest: WebContents): Promise<EmbedderFocusMemo | null> {
  const host = guest.hostWebContents;
  if (!host || host.isDestroyed()) return null;
  const token = randomUUID();
  const captured: unknown = await host.executeJavaScriptInIsolatedWorld(
    EMBEDDER_FOCUS_WORLD_ID,
    [{ code: captureScript(token) }],
    false
  );
  return captured === true ? { host, token } : null;
}

/** Tıklamanın taşıdığı odağı geri verir; odak değişmezse kısa bir süre bekleyip vazgeçer. */
export async function restoreEmbedderFocus(memo: EmbedderFocusMemo): Promise<void> {
  for (const wait of RESTORE_POLL_DELAYS_MS) {
    if (wait > 0) await delay(wait);
    if (memo.host.isDestroyed()) return;
    const status: unknown = await memo.host.executeJavaScriptInIsolatedWorld(
      EMBEDDER_FOCUS_WORLD_ID,
      [{ code: restoreScript(memo.token) }],
      false
    );
    if (status !== 'unchanged') return;
  }
}
