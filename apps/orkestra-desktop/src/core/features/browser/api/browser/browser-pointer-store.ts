import { action, makeObservable, observable } from 'mobx';

export type AgentPointerState = {
  x: number;
  y: number;
  action: 'move' | 'click';
  at: number;
};

export type BrowserFindState = {
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
};

const POINTER_IDLE_MS = 1500;

export class BrowserPointerStore {
  readonly pointers = observable.map<string, AgentPointerState>();
  readonly findResults = observable.map<string, BrowserFindState>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    makeObservable(this, {
      pointers: observable,
      findResults: observable,
      setPointer: action,
      clearPointer: action,
      setFindResult: action,
      clearFindResult: action,
      forgetBrowser: action,
    });
  }

  setPointer(browserId: string, pointer: AgentPointerState): void {
    this.pointers.set(browserId, pointer);
    const prev = this.timers.get(browserId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.timers.delete(browserId);
      this.clearPointer(browserId);
    }, POINTER_IDLE_MS);
    this.timers.set(browserId, timer);
  }

  clearPointer(browserId: string): void {
    const prev = this.timers.get(browserId);
    if (prev) {
      clearTimeout(prev);
      this.timers.delete(browserId);
    }
    this.pointers.delete(browserId);
  }

  getPointer(browserId: string): AgentPointerState | undefined {
    return this.pointers.get(browserId);
  }

  setFindResult(browserId: string, result: BrowserFindState): void {
    this.findResults.set(browserId, result);
  }

  clearFindResult(browserId: string): void {
    this.findResults.delete(browserId);
  }

  getFindResult(browserId: string): BrowserFindState | undefined {
    return this.findResults.get(browserId);
  }

  forgetBrowser(browserId: string): void {
    this.clearPointer(browserId);
    this.findResults.delete(browserId);
  }
}

export const browserPointerStore = new BrowserPointerStore();
