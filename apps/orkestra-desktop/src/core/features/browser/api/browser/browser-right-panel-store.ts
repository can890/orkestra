import { action, computed, makeObservable, observable, untracked } from 'mobx';
import { browserAgentActivity } from '@core/features/browser/api/browser/browser-agent-activity';
import { browserDiagnosticsStore } from '@core/features/browser/api/browser/browser-diagnostics-store';
import { browserMiniPlayerStore } from '@core/features/browser/api/browser/browser-mini-player-store';
import { browserPointerStore } from '@core/features/browser/api/browser/browser-pointer-store';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { browserWebviewHost } from '@core/features/browser/api/browser/browser-webview-host';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import { getAppSettingValueSnapshot } from '@core/features/settings/api/browser/app-settings-client';
import {
  normalizeBrowserProfileSelection,
  type BrowserProfileSelection,
  type BrowserSessionSnapshot,
  type BrowserTaskActiveTabs,
} from '@core/primitives/browser/api';

const PANEL_PREFS_STORAGE_KEY = 'orkestra:browser-panel-prefs';
export const DEFAULT_BROWSER_PANEL_WIDTH = 480;
export const MIN_BROWSER_PANEL_WIDTH = 320;
export const MAX_BROWSER_PANEL_WIDTH = 960;

export type TaskBrowserIdentity = {
  projectId: string;
  workspaceId: string;
  taskId: string;
};

export type TaskRightPanelState = {
  projectId: string;
  workspaceId: string;
  taskId: string;
  open: boolean;
  maximized: boolean;
  tabIds: string[];
  activeBrowserId: string | null;
};

export type OpenBrowserTabOptions = {
  initialUrl?: string;
  browserId?: string;
  profileId?: BrowserProfileSelection;
  mode?: 'panel' | 'mini-player';
  activate?: boolean;
};

export function taskBrowserPanelKey(projectId: string, taskId: string): string {
  return `${projectId}\u0000${taskId}`;
}

function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_BROWSER_PANEL_WIDTH;
  return Math.max(MIN_BROWSER_PANEL_WIDTH, Math.min(MAX_BROWSER_PANEL_WIDTH, Math.round(width)));
}

function readPersistedPanelWidth(): number {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return DEFAULT_BROWSER_PANEL_WIDTH;
  }
  try {
    const raw = window.localStorage.getItem(PANEL_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_BROWSER_PANEL_WIDTH;
    const parsed = JSON.parse(raw) as { panelWidth?: unknown };
    return typeof parsed.panelWidth === 'number'
      ? clampPanelWidth(parsed.panelWidth)
      : DEFAULT_BROWSER_PANEL_WIDTH;
  } catch {
    return DEFAULT_BROWSER_PANEL_WIDTH;
  }
}

function persistPanelWidth(panelWidth: number): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  try {
    window.localStorage.setItem(PANEL_PREFS_STORAGE_KEY, JSON.stringify({ panelWidth }));
  } catch {
    // Depolama kotası aşımında sessizce yoksay.
  }
}

export class BrowserRightPanelStore {
  readonly states = observable.map<string, TaskRightPanelState>({}, { deep: false });
  panelWidth: number = readPersistedPanelWidth();
  private readonly openInNewTabSubscribed = new Set<string>();
  private eventsUnsubscribe: (() => void) | null = null;
  private eventsConnecting = false;

  constructor() {
    makeObservable(this, {
      states: observable,
      panelWidth: observable,
      activeTaskBrowsers: computed,
      setPanelWidth: action,
      openTab: action,
      adoptLegacyTab: action,
      floatTabToMiniPlayer: action,
      dockMiniPlayerToPanel: action,
      closeMiniPlayer: action,
      closeTab: action,
      setActiveTab: action,
      togglePanel: action,
      openPanel: action,
      closePanel: action,
      toggleMaximized: action,
      activateTabById: action,
      clear: action,
    });
  }

  private ensureState(identity: TaskBrowserIdentity): TaskRightPanelState {
    const key = taskBrowserPanelKey(identity.projectId, identity.taskId);
    const existing = this.states.get(key);
    if (existing) return existing;
    const initial: TaskRightPanelState = {
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      taskId: identity.taskId,
      open: false,
      maximized: false,
      tabIds: [],
      activeBrowserId: null,
    };
    this.states.set(key, initial);
    return initial;
  }

  private resolveProfileId(requested?: BrowserProfileSelection): BrowserProfileSelection {
    const browserSettings = getAppSettingValueSnapshot('browser');
    return normalizeBrowserProfileSelection(
      requested ?? browserSettings?.defaultProfileId,
      browserSettings?.profiles
    );
  }

  private ensureEventSubscription(): void {
    if (this.eventsUnsubscribe || this.eventsConnecting) return;
    this.eventsConnecting = true;
    void getBrowserClient()
      .then((client) =>
        client.events.subscribe(undefined, {
          onEvent: (event) => {
            if (event.type !== 'open-in-new-tab') return;
            if (!this.openInNewTabSubscribed.has(event.sourceBrowserId)) return;
            const sourceSession = browserSessionStore.getSession(event.sourceBrowserId);
            if (!sourceSession) return;
            const floating = browserMiniPlayerStore.isFloating(event.sourceBrowserId);
            this.openTab(
              {
                projectId: sourceSession.projectId,
                workspaceId: sourceSession.workspaceId,
                taskId: sourceSession.taskId,
              },
              {
                initialUrl: event.url,
                profileId: sourceSession.profileId,
                mode: floating ? 'mini-player' : 'panel',
                activate: true,
              }
            );
          },
        })
      )
      .then((unsub) => {
        this.eventsUnsubscribe = unsub;
        this.eventsConnecting = false;
      })
      .catch(() => {
        this.eventsConnecting = false;
      });
  }

  get activeTaskBrowsers(): BrowserTaskActiveTabs[] {
    return this.collectActiveBrowsers();
  }

  setPanelWidth(width: number): void {
    const next = clampPanelWidth(width);
    this.panelWidth = next;
    persistPanelWidth(next);
  }

  getState(projectId: string, taskId: string): TaskRightPanelState | undefined {
    return this.states.get(taskBrowserPanelKey(projectId, taskId));
  }

  isOpen(projectId: string, taskId: string): boolean {
    return Boolean(this.getState(projectId, taskId)?.open);
  }

  isMaximized(projectId: string, taskId: string): boolean {
    return Boolean(this.getState(projectId, taskId)?.maximized);
  }

  tabsForTask(projectId: string, taskId: string): string[] {
    const state = this.getState(projectId, taskId);
    if (!state) return [];
    const floatingId = browserMiniPlayerStore.floatingBrowserForTask(projectId, taskId);
    return state.tabIds.filter(
      (id) => id !== floatingId && Boolean(browserSessionStore.getSession(id))
    );
  }

  activeTabForTask(projectId: string, taskId: string): string | null {
    const state = this.getState(projectId, taskId);
    if (!state) return null;
    const panelTabs = this.tabsForTask(projectId, taskId);
    if (panelTabs.length === 0) return null;
    if (state.activeBrowserId && panelTabs.includes(state.activeBrowserId)) {
      return state.activeBrowserId;
    }
    return panelTabs[0] ?? null;
  }

  visibleBrowserForTask(projectId: string, taskId: string): string | null {
    const state = this.getState(projectId, taskId);
    if (state?.open) {
      return this.activeTabForTask(projectId, taskId);
    }
    const floatingId = browserMiniPlayerStore.floatingBrowserForTask(projectId, taskId);
    if (floatingId && browserSessionStore.getSession(floatingId)) return floatingId;
    return null;
  }

  hasTab(browserId: string): boolean {
    if (browserMiniPlayerStore.isFloating(browserId)) return true;
    for (const state of this.states.values()) {
      if (state.tabIds.includes(browserId)) return true;
    }
    return false;
  }

  taskForBrowser(browserId: string): TaskBrowserIdentity | null {
    const session = browserSessionStore.getSession(browserId);
    if (session) {
      return {
        projectId: session.projectId,
        workspaceId: session.workspaceId,
        taskId: session.taskId,
      };
    }
    for (const state of this.states.values()) {
      if (state.tabIds.includes(browserId)) {
        return {
          projectId: state.projectId,
          workspaceId: state.workspaceId,
          taskId: state.taskId,
        };
      }
    }
    return null;
  }

  openTab(identity: TaskBrowserIdentity, options: OpenBrowserTabOptions = {}): string {
    const key = taskBrowserPanelKey(identity.projectId, identity.taskId);
    const state = this.ensureState(identity);
    let session = options.browserId ? browserSessionStore.getSession(options.browserId) : undefined;
    if (!session) {
      session = browserSessionStore.createSession({
        projectId: identity.projectId,
        workspaceId: identity.workspaceId,
        taskId: identity.taskId,
        browserId: options.browserId,
        profileId: this.resolveProfileId(options.profileId),
        initialUrl: options.initialUrl,
      });
    } else if (options.initialUrl) {
      browserWebviewHost.load(session.browserId, options.initialUrl);
    }

    const browserId = session.browserId;
    this.openInNewTabSubscribed.add(browserId);
    this.ensureEventSubscription();

    const mode = options.mode ?? 'panel';
    if (mode === 'mini-player') {
      browserMiniPlayerStore.openFloating(identity.projectId, identity.taskId, browserId);
      const nextTabs = state.tabIds.includes(browserId)
        ? state.tabIds
        : [...state.tabIds, browserId];
      this.states.set(key, {
        ...state,
        tabIds: nextTabs,
      });
      return browserId;
    }

    if (browserMiniPlayerStore.floatingBrowserForTask(identity.projectId, identity.taskId) === browserId) {
      browserMiniPlayerStore.closeFloating(identity.projectId, identity.taskId);
    }

    const nextTabs = state.tabIds.includes(browserId) ? state.tabIds : [...state.tabIds, browserId];
    const shouldActivate = options.activate !== false || state.activeBrowserId === null;
    this.states.set(key, {
      ...state,
      open: true,
      tabIds: nextTabs,
      activeBrowserId: shouldActivate ? browserId : state.activeBrowserId,
    });
    return browserId;
  }

  adoptLegacyTab(session: BrowserSessionSnapshot): string {
    const identity: TaskBrowserIdentity = {
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      taskId: session.taskId,
    };
    const key = taskBrowserPanelKey(identity.projectId, identity.taskId);
    const state = this.ensureState(identity);
    this.openInNewTabSubscribed.add(session.browserId);
    this.ensureEventSubscription();

    if (state.tabIds.includes(session.browserId)) {
      this.states.set(key, {
        ...state,
        open: true,
        activeBrowserId: state.activeBrowserId ?? session.browserId,
      });
      return session.browserId;
    }

    this.states.set(key, {
      ...state,
      open: true,
      tabIds: [...state.tabIds, session.browserId],
      activeBrowserId: state.activeBrowserId ?? session.browserId,
    });
    return session.browserId;
  }

  floatTabToMiniPlayer(projectId: string, taskId: string, browserId: string): void {
    const key = taskBrowserPanelKey(projectId, taskId);
    const state = this.getState(projectId, taskId);
    if (!state) return;

    browserMiniPlayerStore.openFloating(projectId, taskId, browserId);
    const panelTabs = state.tabIds.filter(
      (id) => id !== browserId && Boolean(browserSessionStore.getSession(id))
    );
    const nextActive = panelTabs.includes(state.activeBrowserId ?? '')
      ? state.activeBrowserId
      : (panelTabs[0] ?? null);

    this.states.set(key, {
      ...state,
      open: panelTabs.length > 0 ? state.open : false,
      maximized: panelTabs.length > 0 ? state.maximized : false,
      activeBrowserId: nextActive,
    });
  }

  dockMiniPlayerToPanel(projectId: string, taskId: string, browserId: string): void {
    const session = browserSessionStore.getSession(browserId);
    if (!session) return;
    const key = taskBrowserPanelKey(projectId, taskId);
    const state = this.ensureState({
      projectId,
      workspaceId: session.workspaceId,
      taskId,
    });
    browserMiniPlayerStore.closeFloating(projectId, taskId);
    const nextTabs = state.tabIds.includes(browserId) ? state.tabIds : [...state.tabIds, browserId];
    this.states.set(key, {
      ...state,
      open: true,
      tabIds: nextTabs,
      activeBrowserId: browserId,
    });
  }

  closeMiniPlayer(projectId: string, taskId: string): void {
    const floatingId = browserMiniPlayerStore.floatingBrowserForTask(projectId, taskId);
    browserMiniPlayerStore.closeFloating(projectId, taskId);
    if (!floatingId) return;

    const state = this.getState(projectId, taskId);
    const hasOpenPanel = Boolean(state?.open);
    if (!hasOpenPanel) {
      // Kapatılan mini oynatıcı sağ panelde gösterilmiyorsa oturumu da sonlandır (ses durur).
      this.closeTab(projectId, taskId, floatingId);
    }
  }

  closeTab(projectId: string, taskId: string, browserId: string): void {
    const key = taskBrowserPanelKey(projectId, taskId);
    const state = this.getState(projectId, taskId);
    if (browserMiniPlayerStore.floatingBrowserForTask(projectId, taskId) === browserId) {
      browserMiniPlayerStore.closeFloating(projectId, taskId);
    }
    this.openInNewTabSubscribed.delete(browserId);

    if (state) {
      const idx = state.tabIds.indexOf(browserId);
      const nextTabs = state.tabIds.filter((id) => id !== browserId);
      const remainingPanelTabs = nextTabs.filter(
        (id) =>
          id !== browserMiniPlayerStore.floatingBrowserForTask(projectId, taskId) &&
          Boolean(browserSessionStore.getSession(id))
      );
      let nextActive: string | null = state.activeBrowserId;
      if (nextActive === browserId || !remainingPanelTabs.includes(nextActive ?? '')) {
        nextActive =
          remainingPanelTabs[Math.min(Math.max(idx, 0), Math.max(0, remainingPanelTabs.length - 1))] ??
          null;
      }
      this.states.set(key, {
        ...state,
        open: remainingPanelTabs.length > 0 ? state.open : false,
        maximized: remainingPanelTabs.length > 0 ? state.maximized : false,
        tabIds: nextTabs,
        activeBrowserId: nextActive,
      });
    }

    this.disposeBrowserSession(browserId);
  }

  setActiveTab(projectId: string, taskId: string, browserId: string): void {
    const key = taskBrowserPanelKey(projectId, taskId);
    const state = this.getState(projectId, taskId);
    if (!state || !state.tabIds.includes(browserId)) return;
    if (browserMiniPlayerStore.floatingBrowserForTask(projectId, taskId) === browserId) {
      browserMiniPlayerStore.closeFloating(projectId, taskId);
    }
    this.states.set(key, {
      ...state,
      open: true,
      activeBrowserId: browserId,
    });
  }

  activateTabById(browserId: string): boolean {
    const identity = this.taskForBrowser(browserId);
    if (!identity) return false;
    if (browserMiniPlayerStore.floatingBrowserForTask(identity.projectId, identity.taskId) === browserId) {
      return true;
    }
    this.setActiveTab(identity.projectId, identity.taskId, browserId);
    return true;
  }

  openPanel(identity: TaskBrowserIdentity): void {
    const state = this.ensureState(identity);
    const panelTabs = this.tabsForTask(identity.projectId, identity.taskId);
    if (panelTabs.length === 0) {
      this.openTab(identity, { mode: 'panel', activate: true });
      return;
    }
    this.states.set(taskBrowserPanelKey(identity.projectId, identity.taskId), {
      ...state,
      open: true,
      activeBrowserId: this.activeTabForTask(identity.projectId, identity.taskId),
    });
  }

  closePanel(projectId: string, taskId: string): void {
    const key = taskBrowserPanelKey(projectId, taskId);
    const state = this.getState(projectId, taskId);
    if (!state || !state.open) return;
    this.states.set(key, {
      ...state,
      open: false,
      maximized: false,
    });
  }

  togglePanel(identity: TaskBrowserIdentity): void {
    if (this.isOpen(identity.projectId, identity.taskId)) {
      this.closePanel(identity.projectId, identity.taskId);
      return;
    }
    const panelTabs = this.tabsForTask(identity.projectId, identity.taskId);
    if (panelTabs.length > 0) {
      this.openPanel(identity);
      return;
    }
    const floatingId = browserMiniPlayerStore.floatingBrowserForTask(
      identity.projectId,
      identity.taskId
    );
    if (floatingId) {
      this.dockMiniPlayerToPanel(identity.projectId, identity.taskId, floatingId);
      return;
    }
    this.openTab(identity, { mode: 'panel', activate: true });
  }

  toggleMaximized(projectId: string, taskId: string): void {
    const key = taskBrowserPanelKey(projectId, taskId);
    const state = this.getState(projectId, taskId);
    if (!state) return;
    this.states.set(key, { ...state, maximized: !state.maximized });
  }

  collectActiveBrowsers(): BrowserTaskActiveTabs[] {
    const tasks = new Map<string, { projectId: string; taskId: string; ids: Set<string> }>();
    const add = (projectId: string, taskId: string, browserId: string) => {
      const key = taskBrowserPanelKey(projectId, taskId);
      let entry = tasks.get(key);
      if (!entry) {
        entry = { projectId, taskId, ids: new Set() };
        tasks.set(key, entry);
      }
      entry.ids.add(browserId);
    };

    for (const state of this.states.values()) {
      if (!state.open) continue;
      const panelTabs = untracked(() =>
        state.tabIds.filter(
          (id) =>
            id !== browserMiniPlayerStore.floatingBrowserForTask(state.projectId, state.taskId) &&
            Boolean(browserSessionStore.getSession(id))
        )
      );
      const activeId =
        state.activeBrowserId && panelTabs.includes(state.activeBrowserId)
          ? state.activeBrowserId
          : (panelTabs[0] ?? null);
      if (activeId) add(state.projectId, state.taskId, activeId);
    }

    for (const [key, miniState] of browserMiniPlayerStore.states) {
      if (!miniState.browserId) continue;
      const exists = untracked(() => Boolean(browserSessionStore.getSession(miniState.browserId!)));
      if (!exists) continue;
      const sep = key.indexOf('\u0000');
      if (sep <= 0) continue;
      add(key.slice(0, sep), key.slice(sep + 1), miniState.browserId);
    }

    return Array.from(tasks.values())
      .map((entry) => ({
        projectId: entry.projectId,
        taskId: entry.taskId,
        browserIds: Array.from(entry.ids).sort(),
      }))
      .sort((a, b) =>
        a.projectId === b.projectId
          ? a.taskId.localeCompare(b.taskId)
          : a.projectId.localeCompare(b.projectId)
      );
  }

  clear(): void {
    this.states.clear();
    this.openInNewTabSubscribed.clear();
    browserMiniPlayerStore.clear();
  }

  private disposeBrowserSession(browserId: string): void {
    browserDiagnosticsStore.clearBrowser(browserId);
    browserAgentActivity.forget(browserId);
    browserPointerStore.forgetBrowser(browserId);
    browserWebviewHost.forget(browserId);
    browserSessionStore.removeSession(browserId);
    void getBrowserClient()
      .then((client) => client.unregisterSession({ browserId }))
      .catch(() => {});
  }
}

export const browserRightPanelStore = new BrowserRightPanelStore();
