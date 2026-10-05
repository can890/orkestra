import { observable, runInAction } from 'mobx';
import type { BrowserWebviewAdapter } from '../../browser/browser-webview-types';

export type BrowserControls = {
  adapter: BrowserWebviewAdapter | null;
  focusUrl(): void;
};

/**
 * Per-browser controls shared across surfaces. The persistent webview layer owns the webview and
 * registers its adapter; the tab's toolbar registers the URL-field focuser. Adapter reads are
 * observable, so components re-render when a webview becomes ready.
 */
class BrowserControlsRegistry {
  private readonly adapters = observable.map<string, BrowserWebviewAdapter>({}, { deep: false });
  private readonly urlFocusers = new Map<string, () => void>();

  registerAdapter(browserId: string, adapter: BrowserWebviewAdapter): () => void {
    runInAction(() => this.adapters.set(browserId, adapter));
    return () => {
      if (this.adapters.get(browserId) !== adapter) return;
      runInAction(() => this.adapters.delete(browserId));
    };
  }

  registerUrlFocuser(browserId: string, focus: () => void): () => void {
    this.urlFocusers.set(browserId, focus);
    return () => {
      if (this.urlFocusers.get(browserId) === focus) this.urlFocusers.delete(browserId);
    };
  }

  getAdapter(browserId: string): BrowserWebviewAdapter | null {
    return this.adapters.get(browserId) ?? null;
  }

  get(browserId: string): BrowserControls | undefined {
    const adapter = this.adapters.get(browserId) ?? null;
    const focus = this.urlFocusers.get(browserId);
    if (!adapter && !focus) return undefined;
    return { adapter, focusUrl: () => focus?.() };
  }

  clear(): void {
    runInAction(() => this.adapters.clear());
    this.urlFocusers.clear();
  }
}

export const browserControlsRegistry = new BrowserControlsRegistry();
