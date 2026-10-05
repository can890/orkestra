import { useLayoutEffect, useRef, type RefObject } from 'react';
import {
  browserWebviewHost,
  type BrowserDropHighlight,
  type BrowserWebviewClaim,
  type BrowserWebviewRect,
} from '@core/features/browser/api/browser/browser-webview-host';

/** Konum kaymalarını (boyut değişmeden yer değiştirme) yakalamak için yedek ölçüm aralığı. */
const PLACEMENT_POLL_MS = 400;

export type BrowserWebviewSlotInput = {
  browserId: string;
  /** Webview'in kaplayacağı alan (sekme içeriğinin araç çubuğu altındaki kısmı). */
  placeholderRef: RefObject<HTMLElement | null>;
  /** Sürükleme vurgusunun hesaplandığı bölge (sekme içeriğinin tamamı). */
  regionRef: RefObject<HTMLElement | null>;
  /** Webview bu yer tutucuda gösterilsin mi. */
  show: boolean;
  interactive: boolean;
  scopeId: string | undefined;
  highlight: BrowserDropHighlight | null;
};

/**
 * Yer tutucunun görünüm alanındaki dikdörtgenini kalıcı webview katmanına bildirir. Gösterim
 * sürdükçe ResizeObserver, pencere yeniden boyutlanması ve düşük sıklıklı bir yedek ölçümle
 * katmanın yer tutucuyu izlemesini sağlar; gösterim bitince talep bırakılır ve webview gizlenir.
 */
export function useBrowserWebviewSlot(input: BrowserWebviewSlotInput): void {
  const { browserId, placeholderRef, regionRef, show, interactive, scopeId, highlight } = input;
  const claimRef = useRef<BrowserWebviewClaim | null>(null);
  const latest = useRef({ interactive, scopeId, highlight });
  latest.current = { interactive, scopeId, highlight };

  useLayoutEffect(() => {
    if (!show) return;
    const placeholder = placeholderRef.current;
    if (!placeholder) return;

    const claim = browserWebviewHost.claim(browserId, latest.current);
    claimRef.current = claim;
    const measure = () => {
      claim.update({
        rect: visibleRectOf(placeholder, regionRef.current),
        region: regionRef.current ? rectOf(regionRef.current) : null,
      });
    };
    measure();

    let frame: number | null = null;
    const measureSoon = () => {
      measure();
      // Düzen bir sonraki karede oturabilir (panel animasyonları, ardışık yeniden boyutlanmalar).
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    const resizeObserver = new ResizeObserver(measureSoon);
    resizeObserver.observe(placeholder);
    if (regionRef.current) resizeObserver.observe(regionRef.current);
    window.addEventListener('resize', measureSoon);
    const poll = window.setInterval(measure, PLACEMENT_POLL_MS);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', measureSoon);
      window.clearInterval(poll);
      if (frame !== null) cancelAnimationFrame(frame);
      claimRef.current = null;
      claim.release();
    };
  }, [browserId, placeholderRef, regionRef, show]);

  useLayoutEffect(() => {
    claimRef.current?.update({ interactive, scopeId, highlight });
  }, [interactive, scopeId, highlight]);
}

function rectOf(element: HTMLElement): BrowserWebviewRect {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** Yer tutucunun, sekme içeriği bölgesiyle kırpılmış dikdörtgeni. */
function visibleRectOf(placeholder: HTMLElement, region: HTMLElement | null): BrowserWebviewRect {
  const rect = rectOf(placeholder);
  if (!region) return rect;
  const bounds = rectOf(region);
  const left = Math.max(rect.left, bounds.left);
  const top = Math.max(rect.top, bounds.top);
  const right = Math.min(rect.left + rect.width, bounds.left + bounds.width);
  const bottom = Math.min(rect.top + rect.height, bounds.top + bounds.height);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
