import { observable, runInAction } from 'mobx';

/** Ajan bir sekmeyi kullandıktan sonra sekmedeki ipucunun görünür kaldığı süre. */
export const AGENT_ACTIVITY_HINT_MS = 60_000;

/**
 * Renderer tarafında ajanların sekmelerle ilişkisi: hangi sekmeleri bir ajanın açtığı ve
 * hangilerini son zamanlarda sürdüğü. Yalnızca bellekte tutulur; sekme ipucu ve odak kararları
 * (ajan sekmesi URL alanına odak çalmaz) için kullanılır.
 */
export class BrowserAgentActivityStore {
  private readonly activeBrowsers = observable.set<string>();
  private readonly agentOpened = observable.set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly hintMs: number = AGENT_ACTIVITY_HINT_MS) {}

  /** Sekmeyi "ajan tarafından kullanılıyor" olarak işaretler; süre her işarette yenilenir. */
  markActive(browserId: string): void {
    const existing = this.timers.get(browserId);
    if (existing !== undefined) clearTimeout(existing);
    runInAction(() => this.activeBrowsers.add(browserId));
    this.timers.set(
      browserId,
      setTimeout(() => {
        this.timers.delete(browserId);
        runInAction(() => this.activeBrowsers.delete(browserId));
      }, this.hintMs)
    );
  }

  isActive(browserId: string): boolean {
    return this.activeBrowsers.has(browserId);
  }

  markAgentOpened(browserId: string): void {
    runInAction(() => this.agentOpened.add(browserId));
  }

  isAgentOpened(browserId: string): boolean {
    return this.agentOpened.has(browserId);
  }

  forget(browserId: string): void {
    const timer = this.timers.get(browserId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(browserId);
    runInAction(() => {
      this.activeBrowsers.delete(browserId);
      this.agentOpened.delete(browserId);
    });
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    runInAction(() => {
      this.activeBrowsers.clear();
      this.agentOpened.clear();
    });
  }
}

export const browserAgentActivity = new BrowserAgentActivityStore();
