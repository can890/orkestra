import { browserAgentActivity } from '@core/features/browser/api/browser/browser-agent-activity';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import type { TabEntry } from '@core/primitives/workbench-shell/browser/tabs/core/tab-provider';
import type { TabOpenOptions } from '@core/primitives/workbench-shell/browser/tabs/core/tab-provider-registry';
import type { SplitSide } from '@core/primitives/workbench-shell/browser/tabs/pane-drop-target';

/** Ajan sekmelerinin yerleşimi için gereken bölme yüzeyi (PaneStore ile yapısal uyumlu). */
export type AgentPlacementPane = {
  readonly tabOrder: readonly string[];
  readonly entries: {
    get(tabId: string): TabEntry | undefined;
    has(tabId: string): boolean;
    values(): Iterable<TabEntry>;
  };
  readonly resolvedActiveTabId: string | undefined;
  readonly activeEntry: TabEntry | undefined;
  setActiveTab(tabId: string): void;
  closeTab(tabId: string): void;
};

/** Ajan sekmelerinin yerleşimi için gereken bölme düzeni yüzeyi (PaneLayoutStore ile uyumlu). */
export type AgentPlacementLayout = {
  readonly groups: ReadonlyArray<{ readonly paneId: string; readonly pane: AgentPlacementPane }>;
  readonly activePaneId: string;
  insertPane(relativeToPaneId: string, side: SplitSide): string | undefined;
  open(kind: string, args: Record<string, unknown>, config?: TabOpenOptions): void;
};

// Görev başına ajan tarayıcı bölmesi: sonraki ajan sekmeleri yeni bölme açmadan buraya gider.
// Yalnızca bellekte; yeniden yüklemeden sonra ajan sekmesi içeren bölme yeniden bulunur.
const agentPaneByLayout = new WeakMap<AgentPlacementLayout, string>();

/** Bir sekme girdisinin tarayıcı oturum kimliği (tarayıcı sekmesi değilse undefined). */
export function browserIdOfEntry(entry: TabEntry | undefined): string | undefined {
  if (entry?.kind !== 'browser') return undefined;
  const browserId = (entry.state as { browserId?: unknown } | null)?.browserId;
  return typeof browserId === 'string' ? browserId : undefined;
}

/** Bir tarayıcı oturumunun sekmesini düzendeki bölmeler arasında bulur. */
export function findBrowserTab(
  layout: AgentPlacementLayout,
  browserId: string
): { paneId: string; pane: AgentPlacementPane; tabId: string } | undefined {
  for (const group of layout.groups) {
    for (const entry of group.pane.entries.values()) {
      if (browserIdOfEntry(entry) === browserId) {
        return { paneId: group.paneId, pane: group.pane, tabId: entry.tabId };
      }
    }
  }
  return undefined;
}

/** Görevin her bölmesinde öndeki tarayıcı sekmeleri. */
export function frontBrowserIds(layout: AgentPlacementLayout): string[] {
  const browserIds: string[] = [];
  for (const group of layout.groups) {
    const browserId = browserIdOfEntry(group.pane.activeEntry);
    if (browserId) browserIds.push(browserId);
  }
  return browserIds;
}

function paneHasBrowserTab(pane: AgentPlacementPane, predicate: (browserId: string) => boolean) {
  for (const entry of pane.entries.values()) {
    const browserId = browserIdOfEntry(entry);
    if (browserId && predicate(browserId)) return true;
  }
  return false;
}

/**
 * Ajan sekmesinin açılacağı bölme: sohbetin yanında, kullanıcının çalıştığı bölmeyi bozmadan.
 *
 * 1. Bu görev için daha önce seçilen ajan bölmesi hâlâ varsa o.
 * 2. Ajanın açtığı bir sekmeyi barındıran bölme.
 * 3. Tek bölme varsa: boşsa kendisi, değilse sağa bölünerek açılan yeni bölme.
 * 4. Birden çok bölme varsa: öndeki sekmesi tarayıcı olan, sonra tarayıcı sekmesi barındıran,
 *    sonra odaktaki olmayan en sondaki bölme.
 */
export function resolveAgentBrowserPane(layout: AgentPlacementLayout): string {
  const remembered = agentPaneByLayout.get(layout);
  if (remembered && layout.groups.some((group) => group.paneId === remembered)) return remembered;

  const withAgentTab = layout.groups.find((group) =>
    paneHasBrowserTab(group.pane, (browserId) => browserAgentActivity.isAgentOpened(browserId))
  );
  if (withAgentTab) return withAgentTab.paneId;

  const [only] = layout.groups;
  if (layout.groups.length === 1 && only) {
    if (only.pane.tabOrder.length === 0) return only.paneId;
    return layout.insertPane(only.paneId, 'right') ?? only.paneId;
  }

  const frontBrowser = layout.groups.find((group) => browserIdOfEntry(group.pane.activeEntry));
  if (frontBrowser) return frontBrowser.paneId;
  const anyBrowser = layout.groups.find((group) => paneHasBrowserTab(group.pane, () => true));
  if (anyBrowser) return anyBrowser.paneId;
  const notFocused = [...layout.groups].reverse().find((g) => g.paneId !== layout.activePaneId);
  return notFocused?.paneId ?? layout.activePaneId;
}

/**
 * Ajan isteğiyle görevin düzeninde bir tarayıcı sekmesi açar ve oturum kimliğini döndürür.
 * Odaktaki bölmeyi ve geçerli görünümü değiştirmez; `activate` false ise hedef bölmenin öndeki
 * sekmesi korunur. MobX eylemi içinde çağrılmalıdır.
 */
export function openAgentBrowserTab(
  layout: AgentPlacementLayout,
  input: { url?: string; activate: boolean; browserId?: string; profileId?: string }
): string {
  const paneId = resolveAgentBrowserPane(layout);
  const target = layout.groups.find((group) => group.paneId === paneId);
  if (!target) throw new Error('No pane is available for the browser tab.');
  const previousActiveTabId = target.pane.resolvedActiveTabId;
  const browserId = input.browserId ?? crypto.randomUUID();

  layout.open(
    'browser',
    {
      browserId,
      ...(input.url ? { initialUrl: input.url } : {}),
      ...(input.profileId ? { profileId: input.profileId } : {}),
    },
    { target: { paneId }, preview: false }
  );
  if (!browserSessionStore.getSession(browserId)) {
    throw new Error('The browser tab could not be opened.');
  }
  if (
    !input.activate &&
    previousActiveTabId !== undefined &&
    target.pane.entries.has(previousActiveTabId)
  ) {
    target.pane.setActiveTab(previousActiveTabId);
  }
  browserAgentActivity.markAgentOpened(browserId);
  agentPaneByLayout.set(layout, paneId);
  return browserId;
}
