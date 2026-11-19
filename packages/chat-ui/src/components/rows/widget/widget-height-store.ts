import { createSignal, type Accessor } from 'solid-js';
import { WIDGET_DEFAULT_HEIGHT, clampWidgetHeight } from './widget-height';

/**
 * Reported iframe heights by widget id. `measure()` reads the signal inside the row's memo, so a
 * new height re-measures the row and the transcript below moves with it.
 */
const heights = new Map<string, ReturnType<typeof createSignal<number>>>();

function entry(id: string) {
  let signal = heights.get(id);
  if (!signal) {
    signal = createSignal(WIDGET_DEFAULT_HEIGHT);
    heights.set(id, signal);
  }
  return signal;
}

export function widgetHeight(id: string): Accessor<number> {
  return entry(id)[0];
}

export function setWidgetHeight(id: string, height: number): void {
  entry(id)[1](clampWidgetHeight(height));
}
