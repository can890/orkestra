/** Canlı görüntü yoklaması: ~2 fps, çağrılar üst üste binmez, görünmezken kare istenmez. */
export const SCREENSHOT_INTERVAL_MS = 500;
export const SCREENSHOT_ERROR_BACKOFF_MS = 3_000;

export type ScreenshotCapture = () => Promise<
  { success: true; data: { data: string; mimeType: string } } | { success: false; message: string }
>;

export type ScreenshotPollerOptions = {
  capture: ScreenshotCapture;
  onFrame(dataUrl: string): void;
  onError(message: string): void;
  intervalMs?: number;
  errorBackoffMs?: number;
  /** Sekme/pencere görünür değilse yoklama kare almaz (zamanlayıcı yalnızca bekler). */
  isVisible?: () => boolean;
  now?: () => number;
};

export type ScreenshotPoller = { start(): void; stop(): void };

/**
 * Bir cihazın ekran görüntüsünü sırayla ister: bir kare bitmeden bir sonrakini başlatmaz.
 * `stop()` bekleyen zamanlayıcıyı iptal eder ve uçuştaki karenin sonucunu yok sayar.
 */
export function createScreenshotPoller(options: ScreenshotPollerOptions): ScreenshotPoller {
  const interval = options.intervalMs ?? SCREENSHOT_INTERVAL_MS;
  const backoff = options.errorBackoffMs ?? SCREENSHOT_ERROR_BACKOFF_MS;
  const isVisible = options.isVisible ?? (() => true);
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const schedule = (delayMs: number) => {
    if (!running) return;
    timer = setTimeout(() => void tick(), Math.max(0, delayMs));
  };

  const tick = async () => {
    timer = null;
    if (!running) return;
    if (!isVisible()) {
      schedule(interval);
      return;
    }
    const startedAt = now();
    try {
      const result = await options.capture();
      if (!running) return;
      if (result.success) {
        options.onFrame(`data:${result.data.mimeType};base64,${result.data.data}`);
        schedule(interval - (now() - startedAt));
      } else {
        options.onError(result.message);
        schedule(backoff);
      }
    } catch (error) {
      if (!running) return;
      options.onError(error instanceof Error ? error.message : String(error));
      schedule(backoff);
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      void tick();
    },
    stop() {
      running = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
