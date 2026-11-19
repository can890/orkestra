import type { LifecycleHookEvent } from './hook-events';

/**
 * Üreticiler (konuşma/görev/ajan durumu) olayı yalnızca burada yayınlar; kancalar etkin
 * değilken ya da henüz bağlanmamışken çağrı sessizce hiçbir şey yapmaz. Yayın asla
 * bekletmez ve asla fırlatmaz: kanca çalıştırma ajan akışının dışındadır.
 */
let sink: ((event: LifecycleHookEvent) => void) | null = null;

export function attachLifecycleHookSink(next: (event: LifecycleHookEvent) => void): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}

export function emitLifecycleHookEvent(event: LifecycleHookEvent): void {
  try {
    sink?.(event);
  } catch {
    // Yayıncı hatası üreticiyi etkilememeli.
  }
}
