/** Belirtilen süre sonra çözülen söz. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Süre aşımı hatası; çağıranlar askıda kalan işlemi diğer hatalardan ayırt edebilir. */
export class TimeoutError extends Error {
  override name = 'TimeoutError';
}

/**
 * Sözü süre sınırıyla bekler; süre dolarsa `onTimeout` hatasıyla reddeder. Asıl söz askıda
 * kalsa bile (ör. gizli sekmede capturePage) çağıran asla süresiz beklemez.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error = () => new TimeoutError(`Timed out after ${timeoutMs} ms.`)
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), Math.max(0, timeoutMs));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

/** Sayısal bir seçeneği aralığa sıkıştırır; geçersiz değerde varsayılanı döndürür. */
export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
