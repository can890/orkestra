/**
 * `textShimmer` sınıfının parıltısını düşük frekansla ilerleten ortak zamanlayıcı.
 *
 * Parıltı eskiden `background-position` üzerinde sürekli bir CSS animasyonuydu. Bu özellik
 * birleştirici (compositor) tarafından canlandırılamaz; çalışan tek bir araç satırı, ekran dışına
 * kaymış olsa bile, tarayıcı motoruna her karede stil hesabı ve boyama yaptırıyordu (ölçüm: ana iş
 * parçacığında ~65 ms/sn; aynı parıltının saniyede 8 adımla güncellenen hali ~16 ms/sn).
 *
 * Tek bir `setInterval`, o anda belgedeki parlayan öğelerin konumunu günceller. Parlayan öğe
 * yokken ya da pencere gizliyken hiçbir şey yapmaz; son `ChatRoot` ayrıldığında durur.
 */
import { textShimmer } from './effects.css';

const TICK_MS = 125;
/** Bir tam geçişin adım sayısı: 24 adım × 125 ms = 3 sn (eski animasyon süresi). */
const STEPS = 24;

let timer: ReturnType<typeof setInterval> | null = null;
let users = 0;
let step = 0;
let elements: HTMLCollectionOf<Element> | null = null;

/** Adım numarasına karşılık gelen `background-position` değeri (200% → -200%). */
export function shimmerPositionAt(index: number): string {
  const wrapped = ((index % STEPS) + STEPS) % STEPS;
  return `${200 - (400 * wrapped) / STEPS}% 0`;
}

function advance(): void {
  if (document.hidden) return;
  // Canlı koleksiyon: sınıfı taşıyan öğeler eklendikçe/çıktıkça kendiliğinden güncellenir.
  elements ??= document.getElementsByClassName(textShimmer);
  if (elements.length === 0) return;
  step = (step + 1) % STEPS;
  const position = shimmerPositionAt(step);
  for (let i = 0; i < elements.length; i += 1) {
    (elements[i] as HTMLElement).style.backgroundPosition = position;
  }
}

/**
 * Zamanlayıcıyı (gerekirse) başlatır; dönen işlev bu kullanıcının tutuşunu bırakır. Hareket
 * azaltma tercihi açıksa zamanlayıcı hiç çalışmaz ve metin sabit kalır.
 */
export function retainShimmerTicker(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return () => undefined;
  users += 1;
  if (timer === null) timer = setInterval(advance, TICK_MS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users -= 1;
    if (users === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
      elements = null;
    }
  };
}
