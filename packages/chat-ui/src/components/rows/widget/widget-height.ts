/**
 * widget-height — the only message the host accepts from a widget iframe.
 *
 * A widget runs in an opaque-origin sandbox and has no channel to the app except this one:
 * `{ type: 'orkestra-widget-height', height: number }` posted by the document's own reporter
 * script. The host accepts it only from that iframe's `contentWindow`, requires the exact
 * schema, and clamps the value, so a hostile widget can at worst pick a height between the
 * limits.
 */

export const WIDGET_HEIGHT_MESSAGE = 'orkestra-widget-height';

export const WIDGET_MIN_HEIGHT = 40;
export const WIDGET_MAX_HEIGHT = 800;
/** Height used until the widget reports its own. */
export const WIDGET_DEFAULT_HEIGHT = 160;

export function clampWidgetHeight(height: number): number {
  return Math.min(WIDGET_MAX_HEIGHT, Math.max(WIDGET_MIN_HEIGHT, Math.round(height)));
}

/**
 * Returns the clamped height for a valid message sent by `frameWindow`, otherwise null. Any other
 * source, shape, type or non-finite number is ignored.
 */
export function parseWidgetHeightMessage(
  event: { source: unknown; data: unknown },
  frameWindow: unknown
): number | null {
  if (!frameWindow || event.source !== frameWindow) return null;
  const data = event.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const keys = Object.keys(data);
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('height')) return null;
  const message = data as { type?: unknown; height?: unknown };
  if (message.type !== WIDGET_HEIGHT_MESSAGE) return null;
  if (typeof message.height !== 'number' || !Number.isFinite(message.height)) return null;
  return clampWidgetHeight(message.height);
}
