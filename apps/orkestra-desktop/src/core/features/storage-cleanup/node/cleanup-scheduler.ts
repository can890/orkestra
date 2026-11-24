export type SchedulerTimers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type ScheduledTrigger = 'startup' | 'settings' | 'hourly';

export const HOURLY_MS = 60 * 60 * 1000;
/** Ayar değişikliklerinin peş peşe yazımları tek çalıştırmada birleşir. */
export const SETTINGS_DEBOUNCE_MS = 2_000;

const defaultTimers: SchedulerTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Temizliği açılışta, politika değişince (kısa gecikmeyle) ve saatte bir çalıştırır.
 * Aynı anda tek çalıştırma: biri sürerken gelen tetik, o bitince bir kez daha çalışır.
 */
export class CleanupScheduler {
  private readonly timers: SchedulerTimers;
  private hourly: unknown = null;
  private debounce: unknown = null;
  private inFlight: Promise<void> | null = null;
  private pending: ScheduledTrigger | null = null;
  private disposed = false;

  constructor(
    private readonly options: {
      run: (trigger: ScheduledTrigger) => Promise<void>;
      intervalMs?: number;
      debounceMs?: number;
      /** Açılış çalıştırmasını uygulama açılışıyla yarışmasın diye geciktirir. */
      startupDelayMs?: number;
      timers?: SchedulerTimers;
      onError?: (error: unknown) => void;
    }
  ) {
    this.timers = options.timers ?? defaultTimers;
  }

  start(): void {
    const delay = this.options.startupDelayMs ?? 0;
    if (delay > 0) this.timers.setTimeout(() => this.trigger('startup'), delay);
    else this.trigger('startup');
    this.scheduleHourly();
  }

  settingsChanged(): void {
    if (this.disposed) return;
    if (this.debounce !== null) this.timers.clearTimeout(this.debounce);
    this.debounce = this.timers.setTimeout(() => {
      this.debounce = null;
      this.trigger('settings');
    }, this.options.debounceMs ?? SETTINGS_DEBOUNCE_MS);
  }

  /** Süren ve kuyruktaki çalıştırmalar bitince çözülür (testler için). */
  async idle(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }

  dispose(): void {
    this.disposed = true;
    if (this.hourly !== null) this.timers.clearTimeout(this.hourly);
    if (this.debounce !== null) this.timers.clearTimeout(this.debounce);
    this.hourly = null;
    this.debounce = null;
  }

  private scheduleHourly(): void {
    if (this.disposed) return;
    this.hourly = this.timers.setTimeout(() => {
      this.hourly = null;
      this.trigger('hourly');
      this.scheduleHourly();
    }, this.options.intervalMs ?? HOURLY_MS);
  }

  private trigger(trigger: ScheduledTrigger): void {
    if (this.disposed) return;
    if (this.inFlight) {
      this.pending = trigger;
      return;
    }
    this.inFlight = (async () => {
      let next: ScheduledTrigger | null = trigger;
      while (next !== null && !this.disposed) {
        this.pending = null;
        try {
          await this.options.run(next);
        } catch (error) {
          this.options.onError?.(error);
        }
        next = this.pending;
      }
    })().finally(() => {
      this.inFlight = null;
    });
  }
}
