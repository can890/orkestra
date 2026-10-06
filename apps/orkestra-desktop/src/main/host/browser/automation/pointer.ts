import type { BrowserKeyModifier } from '@core/primitives/browser/api/agent-browser';

export type Point = { x: number; y: number };

export type MouseButton = 'left' | 'right' | 'middle';

export type WheelDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Görünür alan CSS koordinatını `sendInputEvent` koordinatına çevirir.
 *
 * Electron 40'ta misafir (webview) WebContents için fare olaylarının x/y değerleri, misafir
 * widget'ının sol üst köşesine göre DIP (device-independent pixel) cinsindendir; cihaz ölçeği
 * (Retina) Chromium tarafından ayrıca uygulanır. Sayfa yakınlaştırması ise bir CSS pikselini
 * `zoomFactor` DIP'e büyütür. Bu yüzden CSS noktası yalnızca `getZoomFactor()` ile çarpılır.
 * Electron 40.10.2 üzerinde doğrulandı: 1.5 yakınlaştırmada ölçeklenmiş nokta hedefi tam
 * merkezinden vurdu, ölçeklenmemiş nokta ıskaladı.
 */
export function cssToWidgetPoint(point: Point, zoomFactor: number): Point {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return { x: point.x * zoom, y: point.y * zoom };
}

export function mouseMoveEvent(
  point: Point,
  modifiers: BrowserKeyModifier[] = []
): Electron.MouseInputEvent {
  return { type: 'mouseMove', x: point.x, y: point.y, modifiers: [...modifiers] };
}

/** Tıklama dizisi: fare hedefe taşınır, ardından her tıklama için mouseDown/mouseUp. */
export function mouseClickEvents(
  point: Point,
  options: { button: MouseButton; clickCount: number; modifiers: BrowserKeyModifier[] }
): Electron.MouseInputEvent[] {
  const events: Electron.MouseInputEvent[] = [mouseMoveEvent(point, options.modifiers)];
  const count = Math.max(1, Math.floor(options.clickCount));
  for (let click = 1; click <= count; click++) {
    for (const type of ['mouseDown', 'mouseUp'] as const) {
      events.push({
        type,
        x: point.x,
        y: point.y,
        button: options.button,
        clickCount: click,
        modifiers: [...options.modifiers],
      });
    }
  }
  return events;
}

/**
 * Fare tekerleği olayı. Electron/Chromium işaret kuralı DOM'un tersidir: negatif deltaY sayfayı
 * aşağı kaydırır. Miktar DIP cinsindendir.
 *
 * `hasPreciseScrollingDeltas` (dokunmatik yüzey gibi piksel deltaları) kullanılır: Electron
 * 40.10.2'de deneyle doğrulandı ki kesin deltalar canlandırmasız, tam miktarda ve hemen
 * uygulanır; kesin olmayan deltalar canlandırılır ve az önce kaydırılan öğeye "kilitlenip"
 * (scroll latching) imlecin altındaki iç kaydırıcı yerine pencereyi kaydırabilir.
 */
export function mouseWheelEvent(
  point: Point,
  direction: WheelDirection,
  amountDip: number
): Electron.MouseWheelInputEvent {
  const amount = Math.abs(amountDip);
  return {
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    deltaX: direction === 'left' ? amount : direction === 'right' ? -amount : 0,
    deltaY: direction === 'up' ? amount : direction === 'down' ? -amount : 0,
    hasPreciseScrollingDeltas: true,
  };
}
