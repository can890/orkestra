import { nativeImage, type NativeImage, type WebContents } from 'electron';
import type { BrowserScreenshot } from '@core/primitives/browser/api/agent-browser';
import type { CdpSession } from './cdp-session';
import type { PageMetrics } from './page-script';
import { TimeoutError, withTimeout } from './timing';

/**
 * Sekme ekran görüntüsü.
 *
 * Electron 40.10.2 üzerinde doğrulanan davranış: webview `visibility:hidden` ile (ya da görünür
 * alanın dışına taşınarak) gizlendiğinde Chromium misafir çerçeveyi "çizilmiyor" sayar;
 * `capturePage()` (stayHidden/stayAwake seçenekleriyle de) ve CDP `Page.captureScreenshot`
 * hiç çözülmeden askıda kalır. `opacity:0` ile gizlenen ya da görünür sekmede ikisi de çalışır.
 * Bu yüzden her yakalama süre sınırlıdır: önce capturePage denenir; reddedilirse (yüzey yok)
 * CDP denenir; süre aşımı ise sekmenin çizilmediği anlamına gelir ve ajana hemen açık bir hata
 * verilir.
 *
 * Görüntü CSS piksel ölçeğine indirilir (Retina'da yarı boyut): görünür alan görüntüsünde bir
 * görüntü pikseli bir CSS pikseline denk gelir, böylece {x, y} hedefleri doğrudan görüntüden
 * okunabilir. Ardından en uzun kenar en fazla 1600 piksele küçültülür.
 */

export const SCREENSHOT_MAX_SIDE = 1600;
/** Tam sayfa görüntüsünde yakalanan en fazla CSS yüksekliği. */
export const FULL_PAGE_MAX_CSS_HEIGHT = 10_000;
export const CAPTURE_TIMEOUT_MS = 3_000;
const CDP_CAPTURE_TIMEOUT_MS = 5_000;
const FULL_PAGE_TIMEOUT_MS = 10_000;

export const HIDDEN_TAB_SCREENSHOT_ERROR =
  'Could not capture a screenshot: the tab is not being rendered right now (it is probably ' +
  'hidden in the background). Activate the tab and retry; snapshot and getText still work on ' +
  'hidden tabs.';

type LayoutMetrics = {
  cssContentSize?: { width: number; height: number };
  contentSize?: { width: number; height: number };
};

export type ScreenshotRequest = {
  webContents: WebContents;
  cdp: CdpSession;
  fullPage: boolean;
  metrics: PageMetrics | null;
};

export async function captureScreenshot(request: ScreenshotRequest): Promise<BrowserScreenshot> {
  if (request.fullPage) {
    try {
      const full = await captureFullPage(request);
      if (full) return full;
    } catch (error) {
      if (error instanceof TimeoutError) throw new Error(HIDDEN_TAB_SCREENSHOT_ERROR);
      // Diğer hatalarda görünür alan görüntüsüne düşülür.
    }
  }
  const image = await captureViewportImage(request);
  return encodeImage(image, request.metrics?.viewportWidth ?? null);
}

async function captureViewportImage(request: ScreenshotRequest): Promise<NativeImage> {
  const { webContents, cdp } = request;
  try {
    const image = await withTimeout(webContents.capturePage(), CAPTURE_TIMEOUT_MS);
    if (!image.isEmpty()) return image;
  } catch (error) {
    // Süre aşımı: sekme çizilmiyor, CDP de askıda kalır.
    if (error instanceof TimeoutError) throw new Error(HIDDEN_TAB_SCREENSHOT_ERROR);
  }
  try {
    const shot = await cdp.send<{ data?: string }>(
      'Page.captureScreenshot',
      { format: 'png' },
      CDP_CAPTURE_TIMEOUT_MS
    );
    if (shot.data) {
      const image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
      if (!image.isEmpty()) return image;
    }
  } catch {
    // Aşağıdaki açık hata verilecek.
  }
  throw new Error(HIDDEN_TAB_SCREENSHOT_ERROR);
}

async function captureFullPage(request: ScreenshotRequest): Promise<BrowserScreenshot | null> {
  const { cdp } = request;
  if (!cdp.ensureAttached()) return null;
  const layout = await cdp.send<LayoutMetrics>('Page.getLayoutMetrics', {}, CDP_CAPTURE_TIMEOUT_MS);
  const content = layout.cssContentSize ?? layout.contentSize;
  if (!content || content.width <= 0 || content.height <= 0) return null;
  const width = Math.ceil(content.width);
  const height = Math.min(Math.ceil(content.height), FULL_PAGE_MAX_CSS_HEIGHT);
  const targetScale = Math.min(1, SCREENSHOT_MAX_SIDE / Math.max(width, height));
  const devicePixelRatio = request.metrics?.devicePixelRatio ?? 1;
  const shot = await cdp.send<{ data?: string }>(
    'Page.captureScreenshot',
    {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: targetScale / Math.max(devicePixelRatio, 0.01) },
    },
    FULL_PAGE_TIMEOUT_MS
  );
  if (!shot.data) return null;
  const image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
  if (image.isEmpty()) return null;
  return encodeImage(image, Math.round(width * targetScale));
}

/** Hedef genişliğe (CSS piksel) ve en uzun kenar sınırına göre küçültüp PNG'ye çevirir. */
export function encodeImage(image: NativeImage, cssWidth: number | null): BrowserScreenshot {
  const size = image.getSize();
  let width = size.width;
  let height = size.height;
  if (cssWidth !== null && cssWidth > 0 && width > cssWidth) {
    height = Math.max(1, Math.round((height * cssWidth) / width));
    width = Math.round(cssWidth);
  }
  const longest = Math.max(width, height);
  if (longest > SCREENSHOT_MAX_SIDE) {
    const factor = SCREENSHOT_MAX_SIDE / longest;
    width = Math.max(1, Math.round(width * factor));
    height = Math.max(1, Math.round(height * factor));
  }
  const output =
    width !== size.width || height !== size.height
      ? image.resize({ width, height, quality: 'good' })
      : image;
  const finalSize = output.getSize();
  return {
    mimeType: 'image/png',
    data: output.toPNG().toString('base64'),
    width: finalSize.width,
    height: finalSize.height,
  };
}
