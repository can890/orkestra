/**
 * Düşük frekanslı ortak animasyon zamanlayıcısı.
 *
 * Neden var: sürekli çalışan bir CSS animasyonu (adımlı olsa bile) tarayıcı motoruna ekranın her
 * karesinde stil hesabı yaptırır; 120 Hz ekranda 24 piksellik tek bir "çalışıyor" göstergesi
 * bile pencereye %15'in üzerinde CPU ve GPU yükü bindirir (ölçüm: sürekli SVG nokta dalgası
 * ana iş parçacığında ~97 ms/sn, aynı görünümün saniyede 8 kez güncellenen hali ~20 ms/sn).
 * Uzun süre görünür kalan göstergeler bu yüzden CSS animasyonu yerine buradaki tek zamanlayıcıya
 * abone olur ve her tıkta yalnızca kendi öğesindeki bir özniteliği/stili değiştirir.
 *
 * Tek `setInterval` tüm aboneler arasında paylaşılır, abone kalmayınca durur ve pencere gizliyken
 * tık üretmez.
 */

export const ANIMATION_TICK_MS = 125;

type TickListener = (tick: number) => void;

const listeners = new Set<TickListener>();
let timer: ReturnType<typeof setInterval> | null = null;
let tick = 0;

function emit(): void {
  if (typeof document !== 'undefined' && document.hidden) return;
  tick += 1;
  for (const listener of listeners) listener(tick);
}

/** Kullanıcı hareketi azaltmayı seçtiyse göstergeler sabit kalmalı. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Zamanlayıcıya abone olur; dönen işlev aboneliği bitirir. Dinleyici hemen bir kez mevcut tık
 * değeriyle çağrılır, böylece yeni bağlanan gösterge ötekilerle aynı fazda başlar.
 */
export function subscribeAnimationTicker(listener: TickListener): () => void {
  listeners.add(listener);
  if (timer === null) timer = setInterval(emit, ANIMATION_TICK_MS);
  listener(tick);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Testler için: çalışan zamanlayıcı ve abone sayısı. */
export function animationTickerState(): { running: boolean; listeners: number } {
  return { running: timer !== null, listeners: listeners.size };
}
