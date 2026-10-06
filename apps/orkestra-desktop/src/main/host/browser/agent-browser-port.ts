import type { WebContents } from 'electron';
import type { AgentBrowserPort, AgentBrowserTab } from '@core/primitives/browser/api/agent-browser';
import {
  createPageAutomation,
  type MainPageAutomation,
} from '@main/host/browser/automation/page-automation';
import {
  browserWebContentsRegistry,
  type BrowserWebContentsRegistry,
} from '@main/host/browser/browser-webcontents-registry';

/** Port'un ihtiyaç duyduğu kayıt yüzeyi; testlerde sahte bir kayıt verilebilir. */
export type AgentBrowserRegistry = Pick<
  BrowserWebContentsRegistry,
  | 'listTabs'
  | 'getTab'
  | 'getLiveWebContents'
  | 'requestOpenTab'
  | 'requestActivateTab'
  | 'requestCloseTab'
  | 'markAgentActivity'
  | 'onBrowserReleased'
>;

export type AgentBrowserPortDeps = {
  registry: AgentBrowserRegistry;
  createPageAutomation: (webContents: WebContents) => MainPageAutomation;
};

/**
 * Ana süreçteki AgentBrowserPort. Sözleşmeye ek olarak, araç tarafının bir sekmede ajan
 * etkinliğini işaretlemesi (sekmedeki kısa süreli ajan ipucu) ve kapatma için iki yardımcı sunar.
 */
export type MainAgentBrowserPort = AgentBrowserPort & {
  /** Sekmeyi "ajan tarafından kullanılıyor" olarak işaretler; `page()` bunu kendisi de yapar. */
  markAgentActivity(browserId: string): void;
  /** Önbellekteki tüm sayfa kontrolcülerini bırakır ve kayıt dinleyicisini kaldırır. */
  dispose(): void;
};

type CachedPage = {
  browserId: string;
  webContents: WebContents;
  automation: MainPageAutomation;
  onDestroyed: () => void;
};

export function createAgentBrowserPort(deps: AgentBrowserPortDeps): MainAgentBrowserPort {
  const { registry } = deps;
  // WebContents kimliğine göre önbellek: aynı sayfa için ajanın referansları (snapshot ref'leri)
  // çağrılar arasında korunur; sayfa yok olunca ya da sekme kapanınca kontrolcü bırakılır.
  const pagesByWebContentsId = new Map<number, CachedPage>();

  const disposeEntry = (webContentsId: number) => {
    const entry = pagesByWebContentsId.get(webContentsId);
    if (!entry) return;
    pagesByWebContentsId.delete(webContentsId);
    if (!entry.webContents.isDestroyed()) {
      entry.webContents.removeListener('destroyed', entry.onDestroyed);
    }
    try {
      entry.automation.dispose();
    } catch {
      // Bırakma hatası diğer sekmelerin temizliğini engellememeli.
    }
  };

  const disposeBrowser = (browserId: string) => {
    for (const [webContentsId, entry] of [...pagesByWebContentsId]) {
      if (entry.browserId === browserId) disposeEntry(webContentsId);
    }
  };

  const stopListening = registry.onBrowserReleased(disposeBrowser);

  return {
    listTabs: (scope) => registry.listTabs(scope),

    getTab: (browserId) => registry.getTab(browserId),

    async openTab(input): Promise<AgentBrowserTab> {
      const tab = await registry.requestOpenTab(input);
      registry.markAgentActivity(tab.browserId);
      return tab;
    },

    async activateTab(browserId): Promise<void> {
      await registry.requestActivateTab(browserId);
      registry.markAgentActivity(browserId);
    },

    async closeTab(browserId): Promise<void> {
      await registry.requestCloseTab(browserId);
      disposeBrowser(browserId);
    },

    page(browserId) {
      const webContents = registry.getLiveWebContents(browserId);
      if (!webContents) {
        disposeBrowser(browserId);
        return null;
      }
      let entry = pagesByWebContentsId.get(webContents.id);
      if (entry && entry.browserId !== browserId) {
        disposeEntry(webContents.id);
        entry = undefined;
      }
      if (!entry) {
        const webContentsId = webContents.id;
        const automation = deps.createPageAutomation(webContents);
        const onDestroyed = () => disposeEntry(webContentsId);
        webContents.once('destroyed', onDestroyed);
        entry = { browserId, webContents, automation, onDestroyed };
        pagesByWebContentsId.set(webContentsId, entry);
      }
      registry.markAgentActivity(browserId);
      // Ağ kaydı yalnızca ajan sekmeyi kullandığında başlar.
      entry.automation.startNetworkCapture();
      return entry.automation;
    },

    markAgentActivity: (browserId) => registry.markAgentActivity(browserId),

    dispose() {
      stopListening();
      for (const webContentsId of [...pagesByWebContentsId.keys()]) disposeEntry(webContentsId);
    },
  };
}

/** Uygulama genelindeki port; bootstrap bunu ajan tarayıcı araçlarına verir. */
export const agentBrowserPort: MainAgentBrowserPort = createAgentBrowserPort({
  registry: browserWebContentsRegistry,
  createPageAutomation,
});
