import { randomUUID } from 'node:crypto';
import {
  clipboard,
  Menu,
  session,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type ClearDataOptions,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import { browserEvents, hasBrowserEventSubscribers } from '@core/features/browser/node';
import type { BrowserSessionRegistration } from '@core/features/browser/node/wire-controller';
import { desktopHostEvents } from '@core/features/workbench/node';
import { buildBrowserClaims, type BrowserClaim } from '@core/manifests/shared/browser-claims';
import {
  BROWSER_DEFAULT_URL,
  browserProfilePartition,
  isNamedBrowserProfileId,
  normalizeBrowserUrl,
  type BrowserAgentRequestReply,
  type BrowserDataClearKind,
  type BrowserEvent,
  type BrowserTaskActiveTabs,
  type BrowserUrlRejectionReason,
  type BrowsingDataKind,
} from '@core/primitives/browser/api';
import type { AgentBrowserTab } from '@core/primitives/browser/api/agent-browser';
import {
  getElectronTabNavigationDirection,
  matchesElectronInput,
  type PlatformContext,
} from '@core/primitives/keybindings/api';
import type { AppSettings } from '@core/services/settings/api';
import { isGoogleAuthUrl, userAgentForBrowserUrl } from './browser-user-agent';

/** The project, workspace and task a browser tab belongs to. */
export type BrowserTaskIdentity = {
  projectId: string;
  workspaceId: string;
  taskId: string;
};

type RegisteredBrowserSession = {
  browserId: string;
  partition: string;
  identity: BrowserTaskIdentity | null;
  url: string;
  title: string;
};

export type BrowserOpenTabRequest = {
  projectId: string;
  workspaceId: string;
  taskId: string;
  url?: string;
  activate?: boolean;
};

type PendingOpenRequest = {
  kind: 'open';
  requestId: string;
  /** Set once the renderer reports the opened tab; the request resolves when its page binds. */
  browserId: string | null;
  resolve: (tab: AgentBrowserTab) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingTabRequest = {
  kind: 'activate' | 'close';
  requestId: string;
  browserId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingAgentRequest = PendingOpenRequest | PendingTabRequest;

export type BrowserWebContentsRegistryOptions = {
  /** Event sink; defaults to `browserEvents`. */
  emit?: (event: BrowserEvent) => void;
  /** True while a renderer listens to browser events; defaults to the event host's state. */
  hasRenderer?: () => boolean;
  /** How long agent requests wait for the renderer. */
  requestTimeoutMs?: number;
  now?: () => number;
};

/** Called when a tab's bound WebContents is released (closed, destroyed or replaced). */
export type BrowserReleasedListener = (browserId: string) => void;

export const AGENT_BROWSER_REQUEST_TIMEOUT_MS = 20_000;
/** Minimum interval between `agent-activity` events for the same tab. */
export const AGENT_ACTIVITY_EVENT_INTERVAL_MS = 10_000;

const NO_RENDERER_MESSAGE =
  'The Orkestra window is not open, so the browser tab request cannot be handled.';
const RENDERER_RELOADED_MESSAGE =
  'The Orkestra window reloaded before the browser tab request completed.';

// OAuth popups become real child windows sharing the browser partition; they
// must stay as locked down as the webview that opened them.
const BROWSER_POPUP_WINDOW_OPTIONS: BrowserWindowConstructorOptions = {
  autoHideMenuBar: true,
  webPreferences: {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
  },
};

// Electron's type union lags Chromium's supported `clearData` values.
const SITE_DATA_CLEAR_DATA_TYPES = [
  'backgroundFetch',
  'cacheStorage',
  'fileSystems',
  'indexedDB',
  'localStorage',
  'serviceWorkers',
  'webSQL',
] as unknown as NonNullable<ClearDataOptions['dataTypes']>;

export class BrowserWebContentsRegistry {
  private readonly sessionsByBrowserId = new Map<string, RegisteredBrowserSession>();
  private readonly webContentsByBrowserId = new Map<string, WebContents>();
  private readonly browserIdByWebContentsId = new Map<number, string>();
  private readonly pendingWebContentsIds = new Set<number>();
  private readonly activeBrowsersByTask = new Map<string, ReadonlySet<string>>();
  private readonly pendingRequests = new Map<string, PendingAgentRequest>();
  private readonly lastActivityEventAt = new Map<string, number>();
  private readonly releasedListeners = new Set<BrowserReleasedListener>();
  private activeBrowserId: string | null = null;
  private browserShortcuts = buildBrowserClaims();
  private readonly emitEvent: (event: BrowserEvent) => void;
  private readonly hasRenderer: () => boolean;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: BrowserWebContentsRegistryOptions = {}) {
    this.emitEvent = options.emit ?? ((event) => browserEvents.emit(undefined, event));
    this.hasRenderer = options.hasRenderer ?? (() => hasBrowserEventSubscribers());
    this.requestTimeoutMs = options.requestTimeoutMs ?? AGENT_BROWSER_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  registerSession(input: BrowserSessionRegistration): void {
    const existing = this.sessionsByBrowserId.get(input.browserId);
    if (existing && existing.partition !== input.partition) {
      // A profile switch remounts the webview on another partition; the old page is going away.
      this.releaseBinding(input.browserId);
    }
    this.sessionsByBrowserId.set(input.browserId, {
      browserId: input.browserId,
      partition: input.partition,
      identity: taskIdentityOf(input) ?? existing?.identity ?? null,
      url: input.url ?? existing?.url ?? BROWSER_DEFAULT_URL,
      title: input.title ?? existing?.title ?? '',
    });
  }

  unregisterSession(browserId: string): void {
    const hadSession = this.sessionsByBrowserId.has(browserId);
    this.releaseBinding(browserId);
    this.sessionsByBrowserId.delete(browserId);
    this.lastActivityEventAt.delete(browserId);
    if (this.activeBrowserId === browserId) {
      this.activeBrowserId = null;
    }
    if (hadSession) {
      this.rejectRequestsForBrowser(
        browserId,
        'The browser tab was closed before the request completed.'
      );
    }
  }

  /**
   * Keeps only the given sessions. A freshly loaded renderer calls this once before it registers
   * anything: the previous renderer's webviews are gone, and so are the requests it was answering.
   */
  syncSessions(browserIds: readonly string[]): void {
    const keep = new Set(browserIds);
    for (const browserId of [...this.sessionsByBrowserId.keys()]) {
      if (!keep.has(browserId)) this.unregisterSession(browserId);
    }
    this.activeBrowsersByTask.clear();
    for (const pending of [...this.pendingRequests.values()]) {
      this.settleRequest(pending);
      pending.reject(new Error(RENDERER_RELOADED_MESSAGE));
    }
  }

  /** Replaces the per-task "front tab of its pane" snapshot reported by the renderer. */
  syncTaskActiveBrowsers(tasks: readonly BrowserTaskActiveTabs[]): void {
    this.activeBrowsersByTask.clear();
    for (const task of tasks) {
      if (task.browserIds.length === 0) continue;
      this.activeBrowsersByTask.set(taskKey(task.projectId, task.taskId), new Set(task.browserIds));
    }
  }

  listTabs(scope: { projectId: string; taskId: string }): AgentBrowserTab[] {
    const tabs: AgentBrowserTab[] = [];
    for (const record of this.sessionsByBrowserId.values()) {
      if (record.identity?.projectId !== scope.projectId) continue;
      if (record.identity.taskId !== scope.taskId) continue;
      tabs.push(this.toAgentTab(record, record.identity));
    }
    return tabs;
  }

  getTab(browserId: string): AgentBrowserTab | null {
    const record = this.sessionsByBrowserId.get(browserId);
    if (!record?.identity) return null;
    return this.toAgentTab(record, record.identity);
  }

  /** The bound, not destroyed WebContents of a tab, or null when the tab is not live. */
  getLiveWebContents(browserId: string): WebContents | null {
    if (!this.sessionsByBrowserId.has(browserId)) return null;
    const webContents = this.webContentsByBrowserId.get(browserId);
    if (!webContents || webContents.isDestroyed()) return null;
    return webContents;
  }

  onBrowserReleased(listener: BrowserReleasedListener): () => void {
    this.releasedListeners.add(listener);
    return () => {
      this.releasedListeners.delete(listener);
    };
  }

  /**
   * Records that an agent drove this tab. The renderer shows a short-lived hint on the tab; the
   * event is throttled per tab.
   */
  markAgentActivity(browserId: string): void {
    if (!this.sessionsByBrowserId.has(browserId)) return;
    const now = this.now();
    const last = this.lastActivityEventAt.get(browserId);
    if (last !== undefined && now - last < AGENT_ACTIVITY_EVENT_INTERVAL_MS) return;
    this.lastActivityEventAt.set(browserId, now);
    this.emitEvent({ type: 'agent-activity', browserId, at: now });
  }

  /**
   * Asks the renderer to open a browser tab in the task without navigating the user, and
   * resolves once the tab's page is bound (controllable).
   */
  requestOpenTab(input: BrowserOpenTabRequest): Promise<AgentBrowserTab> {
    const identity = taskIdentityOf(input);
    if (!identity) {
      return Promise.reject(
        new Error('projectId, workspaceId and taskId are required to open a browser tab.')
      );
    }
    let url: string | undefined;
    if (input.url !== undefined && input.url.trim() !== '') {
      const normalized = normalizeBrowserUrl(input.url, { allowSearchQueries: false });
      if (!normalized.ok) {
        return Promise.reject(
          new Error(`Cannot open "${input.url}": ${describeUrlRejection(normalized.reason)}.`)
        );
      }
      url = normalized.url;
    }
    if (!this.hasRenderer()) return Promise.reject(new Error(NO_RENDERER_MESSAGE));

    const requestId = randomUUID();
    return new Promise<AgentBrowserTab>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        kind: 'open',
        requestId,
        browserId: null,
        resolve,
        reject,
        timer: this.startRequestTimer(requestId, 'open the browser tab'),
      });
      this.emitEvent({
        type: 'open-requested',
        requestId,
        ...identity,
        ...(url ? { url } : {}),
        activate: input.activate ?? true,
      });
    });
  }

  /** Asks the renderer to bring the tab to the front of its pane, without navigating the user. */
  requestActivateTab(browserId: string): Promise<void> {
    return this.requestTabAction('activate', browserId);
  }

  /** Asks the renderer to close the tab; resolves once it is gone. */
  requestCloseTab(browserId: string): Promise<void> {
    return this.requestTabAction('close', browserId);
  }

  /** Applies the renderer's answer to an agent request. Returns false for unknown requests. */
  resolveAgentRequest(reply: BrowserAgentRequestReply): boolean {
    const pending = this.pendingRequests.get(reply.requestId);
    if (!pending) return false;
    if (!reply.ok) {
      this.settleRequest(pending);
      pending.reject(new Error(reply.error || 'The browser tab request failed.'));
      return true;
    }

    switch (pending.kind) {
      case 'open': {
        if (!reply.browserId) {
          this.settleRequest(pending);
          pending.reject(new Error('The Orkestra window did not report the opened browser tab.'));
          return true;
        }
        pending.browserId = reply.browserId;
        this.tryResolveOpenRequest(pending);
        return true;
      }
      case 'activate': {
        this.settleRequest(pending);
        this.markTabActive(pending.browserId);
        pending.resolve();
        return true;
      }
      case 'close': {
        this.settleRequest(pending);
        this.unregisterSession(pending.browserId);
        pending.resolve();
        return true;
      }
    }
  }

  setKeyboardSettings(keyboard: AppSettings['keyboard']): void {
    this.browserShortcuts = buildBrowserClaims(keyboard);
  }

  get registeredPartitions(): ReadonlySet<string> {
    const partitions = new Set<string>();
    for (const registered of this.sessionsByBrowserId.values()) {
      partitions.add(registered.partition);
    }
    return partitions;
  }

  /**
   * Hardens a webview's webContents as soon as it attaches to the main window
   * and closes it unless its session belongs to a registered browser partition.
   * Multiple browsers share one persistent profile partition, so the attached
   * webContents cannot be matched to a browserId here; the renderer binds it
   * via bindWebContents once the webview reports its webContents id.
   */
  handleWebviewAttached(webContents: WebContents): boolean {
    if (!this.isRegisteredPartitionSession(webContents)) {
      webContents.close();
      return false;
    }

    const webContentsId = webContents.id;
    this.pendingWebContentsIds.add(webContentsId);
    this.hardenBrowserWebContents(webContents);
    this.trackPageState(webContents);

    webContents.once('destroyed', () => {
      this.pendingWebContentsIds.delete(webContentsId);
      const boundBrowserId = this.browserIdByWebContentsId.get(webContentsId);
      if (boundBrowserId === undefined) return;
      this.browserIdByWebContentsId.delete(webContentsId);
      if (this.webContentsByBrowserId.get(boundBrowserId) === webContents) {
        this.webContentsByBrowserId.delete(boundBrowserId);
        this.notifyReleased(boundBrowserId);
      }
      if (this.activeBrowserId === boundBrowserId) {
        this.activeBrowserId = null;
      }
    });

    return true;
  }

  bindWebContents(browserId: string, webContents: WebContents): boolean {
    const registered = this.sessionsByBrowserId.get(browserId);
    if (!registered) return false;
    if (webContents.session !== session.fromPartition(registered.partition)) return false;
    const alreadyBoundTo = this.browserIdByWebContentsId.get(webContents.id);
    if (alreadyBoundTo === browserId) return true;
    if (alreadyBoundTo !== undefined || !this.pendingWebContentsIds.has(webContents.id)) {
      return false;
    }

    this.pendingWebContentsIds.delete(webContents.id);
    const previous = this.webContentsByBrowserId.get(browserId);
    if (previous && previous.id !== webContents.id) {
      this.browserIdByWebContentsId.delete(previous.id);
      this.notifyReleased(browserId);
    }
    this.webContentsByBrowserId.set(browserId, webContents);
    this.browserIdByWebContentsId.set(webContents.id, browserId);
    registered.url = webContents.getURL() || registered.url;
    registered.title = webContents.getTitle() || registered.title;
    this.activeBrowserId = browserId;
    this.resolveOpenRequestsFor(browserId);
    return true;
  }

  setActiveBrowser(browserId: string | null): void {
    if (browserId !== null && !this.sessionsByBrowserId.has(browserId)) return;
    this.activeBrowserId = browserId;
  }

  getActiveBrowser(): string | null {
    return this.activeBrowserId;
  }

  openDevTools(browserId: string): boolean {
    const webContents = this.webContentsByBrowserId.get(browserId);
    if (!webContents || webContents.isDestroyed()) return false;
    webContents.openDevTools({ mode: 'detach' });
    return true;
  }

  async captureScreenshotToClipboard(browserId: string): Promise<boolean> {
    const webContents = this.webContentsByBrowserId.get(browserId);
    if (!webContents || webContents.isDestroyed()) return false;
    try {
      const image = await webContents.capturePage();
      if (image.isEmpty()) return false;
      clipboard.writeImage(image);
      return true;
    } catch {
      return false;
    }
  }

  async clearData(browserId: string, kind: BrowserDataClearKind = 'storage'): Promise<boolean> {
    const registered = this.sessionsByBrowserId.get(browserId);
    if (!registered) return false;
    const partitionSession = session.fromPartition(registered.partition);
    switch (kind) {
      case 'storage':
        await partitionSession.clearStorageData();
        break;
      case 'cookies':
        await partitionSession.clearStorageData({ storages: ['cookies'] });
        break;
      case 'cache':
        await partitionSession.clearCache();
        break;
    }
    return true;
  }

  async clearProfileStorage(profileId: string): Promise<boolean> {
    if (!isNamedBrowserProfileId(profileId)) return false;
    await session.fromPartition(browserProfilePartition(profileId)).clearData();
    return true;
  }

  /**
   * Clears a category of browsing data across the given partitions. Used by the
   * global "Browsing data" settings controls, which target every browser
   * profile rather than a single open tab.
   */
  async clearBrowsingData(kind: BrowsingDataKind, partitions: readonly string[]): Promise<boolean> {
    await Promise.all(partitions.map((partition) => clearPartitionBrowsingData(partition, kind)));
    return true;
  }

  private toAgentTab(
    record: RegisteredBrowserSession,
    identity: BrowserTaskIdentity
  ): AgentBrowserTab {
    return {
      browserId: record.browserId,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      taskId: identity.taskId,
      url: record.url,
      title: record.title,
      active:
        this.activeBrowsersByTask
          .get(taskKey(identity.projectId, identity.taskId))
          ?.has(record.browserId) ?? false,
      live: this.getLiveWebContents(record.browserId) !== null,
    };
  }

  private markTabActive(browserId: string): void {
    const identity = this.sessionsByBrowserId.get(browserId)?.identity;
    if (!identity) return;
    const key = taskKey(identity.projectId, identity.taskId);
    const next = new Set(this.activeBrowsersByTask.get(key));
    next.add(browserId);
    this.activeBrowsersByTask.set(key, next);
  }

  private requestTabAction(kind: 'activate' | 'close', browserId: string): Promise<void> {
    if (!this.sessionsByBrowserId.get(browserId)?.identity) {
      return Promise.reject(new Error(`Unknown browser tab: ${browserId}`));
    }
    if (!this.hasRenderer()) return Promise.reject(new Error(NO_RENDERER_MESSAGE));

    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        kind,
        requestId,
        browserId,
        resolve,
        reject,
        timer: this.startRequestTimer(
          requestId,
          kind === 'activate' ? 'activate the browser tab' : 'close the browser tab'
        ),
      });
      this.emitEvent(
        kind === 'activate'
          ? { type: 'activate-requested', requestId, browserId }
          : { type: 'close-requested', requestId, browserId }
      );
    });
  }

  private startRequestTimer(requestId: string, action: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const pending = this.pendingRequests.get(requestId);
      if (!pending) return;
      this.pendingRequests.delete(requestId);
      pending.reject(
        new Error(
          `Timed out after ${Math.round(this.requestTimeoutMs / 1000)} s waiting for the Orkestra window to ${action}.`
        )
      );
    }, this.requestTimeoutMs);
    timer.unref?.();
    return timer;
  }

  private settleRequest(pending: PendingAgentRequest): void {
    clearTimeout(pending.timer);
    this.pendingRequests.delete(pending.requestId);
  }

  private tryResolveOpenRequest(pending: PendingOpenRequest): void {
    if (!pending.browserId) return;
    const record = this.sessionsByBrowserId.get(pending.browserId);
    if (!record?.identity || this.getLiveWebContents(pending.browserId) === null) return;
    this.settleRequest(pending);
    pending.resolve(this.toAgentTab(record, record.identity));
  }

  private resolveOpenRequestsFor(browserId: string): void {
    for (const pending of [...this.pendingRequests.values()]) {
      if (pending.kind === 'open' && pending.browserId === browserId) {
        this.tryResolveOpenRequest(pending);
      }
    }
  }

  private rejectRequestsForBrowser(browserId: string, message: string): void {
    for (const pending of [...this.pendingRequests.values()]) {
      if (pending.browserId !== browserId) continue;
      this.settleRequest(pending);
      pending.reject(new Error(message));
    }
  }

  /** Drops the WebContents binding of a tab (the page stays alive until Electron destroys it). */
  private releaseBinding(browserId: string): void {
    const webContents = this.webContentsByBrowserId.get(browserId);
    if (!webContents) return;
    this.browserIdByWebContentsId.delete(webContents.id);
    this.webContentsByBrowserId.delete(browserId);
    this.notifyReleased(browserId);
  }

  private notifyReleased(browserId: string): void {
    for (const listener of [...this.releasedListeners]) {
      try {
        listener(browserId);
      } catch {
        // A failing listener must not break session bookkeeping.
      }
    }
  }

  /** Keeps the agent-visible url/title of the bound tab current. */
  private trackPageState(webContents: WebContents): void {
    const update = (patch: { url?: string; title?: string }) => {
      const browserId = this.browserIdByWebContentsId.get(webContents.id);
      if (browserId === undefined) return;
      const record = this.sessionsByBrowserId.get(browserId);
      if (!record) return;
      if (patch.url !== undefined) record.url = patch.url;
      if (patch.title !== undefined) record.title = patch.title;
    };
    webContents.on('did-navigate', (_event, url) => update({ url }));
    webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) update({ url });
    });
    webContents.on('page-title-updated', (_event, title) => update({ title }));
  }

  private isRegisteredPartitionSession(webContents: WebContents): boolean {
    for (const partition of this.registeredPartitions) {
      if (session.fromPartition(partition) === webContents.session) {
        return true;
      }
    }
    return false;
  }

  private hardenBrowserWebContents(webContents: WebContents): void {
    webContents.setWindowOpenHandler((details) => {
      if (!isSupportedBrowserNavigationUrl(details.url)) {
        return { action: 'deny' };
      }
      if (details.disposition === 'new-window' && isAllowedAuthPopupUrl(details.url)) {
        // window.open popups (OAuth sign-in flows) need a real child window in
        // the same partition so window.opener/postMessage keep working.
        return { action: 'allow', overrideBrowserWindowOptions: BROWSER_POPUP_WINDOW_OPTIONS };
      }
      const sourceBrowserId = this.browserIdByWebContentsId.get(webContents.id);
      if (sourceBrowserId && isExternalHttpUrl(details.url)) {
        this.emitEvent({
          type: 'open-in-new-tab',
          sourceBrowserId,
          url: details.url,
        });
      }
      return { action: 'deny' };
    });

    webContents.on('before-input-event', (event, input) => {
      const tabNavigationDirection = getElectronTabNavigationDirection(input);
      if (tabNavigationDirection) {
        const browserId = this.browserIdByWebContentsId.get(webContents.id);
        if (browserId) {
          event.preventDefault();
          desktopHostEvents.emit(undefined, {
            type: 'tab-navigation-shortcut',
            source: { kind: 'browser', browserId },
            direction: tabNavigationDirection,
          });
          return;
        }
      }

      const commandId = getBrowserShortcutCommand(input, this.browserShortcuts);
      if (commandId === null) return;

      if (commandId !== 'task.browserCopyUrl') {
        const browserId = this.browserIdByWebContentsId.get(webContents.id);
        if (!browserId) return;
        event.preventDefault();
        desktopHostEvents.emit(undefined, {
          type: 'browser-app-shortcut',
          source: { kind: 'browser', browserId },
          commandId,
        });
        return;
      }

      const normalized = normalizeBrowserUrl(webContents.getURL(), { allowSearchQueries: false });
      if (!normalized.ok || !isExternalHttpUrl(normalized.url)) return;
      event.preventDefault();
      clipboard.writeText(normalized.url);
      this.emitEvent({ type: 'link-copied', kind: 'url', url: normalized.url });
    });

    webContents.on('context-menu', (event, params) => {
      event.preventDefault();
      const selectionText = (params.selectionText ?? '').trim();
      if (!selectionText) {
        clearWebviewSelection(webContents);
      }

      const target = getBrowserContextTarget(params);
      const template: MenuItemConstructorOptions[] = [
        ...(selectionText
          ? [
              {
                label: 'Copy',
                click: () => clipboard.writeText(selectionText),
              },
              { type: 'separator' as const },
            ]
          : []),
        {
          label: target?.kind === 'image' ? 'Copy Image URL' : 'Copy Link',
          enabled: target !== null,
          click: () => {
            if (!target) return;
            clipboard.writeText(target.url);
            this.emitEvent({
              type: 'link-copied',
              kind: target.kind,
              url: target.url,
            });
          },
        },
        {
          label: target?.kind === 'image' ? 'Open Image' : 'Open Link',
          enabled: target !== null,
          click: () => {
            if (target) void webContents.loadURL(target.url);
          },
        },
        {
          label: target?.kind === 'image' ? 'Open Image in New Tab' : 'Open Link in New Tab',
          enabled: target !== null,
          click: () => {
            const sourceBrowserId = this.browserIdByWebContentsId.get(webContents.id);
            if (sourceBrowserId && target) {
              this.emitEvent({
                type: 'open-in-new-tab',
                sourceBrowserId,
                url: target.url,
              });
            }
          },
        },
        { type: 'separator' },
        { label: 'Reload', click: () => webContents.reload() },
      ];

      Menu.buildFromTemplate(template).popup({ x: params.x, y: params.y });
    });

    webContents.on('did-create-window', (window) => {
      hardenBrowserPopupWindow(window);
    });

    webContents.on('will-navigate', (event, url) => {
      if (!isSupportedBrowserNavigationUrl(url)) {
        event.preventDefault();
      }
    });

    installBrowserUserAgentSwitch(webContents);
  }
}

export const browserWebContentsRegistry = new BrowserWebContentsRegistry();

function taskIdentityOf(input: {
  projectId?: string;
  workspaceId?: string;
  taskId?: string;
}): BrowserTaskIdentity | null {
  const projectId = input.projectId?.trim();
  const workspaceId = input.workspaceId?.trim();
  const taskId = input.taskId?.trim();
  if (!projectId || !workspaceId || !taskId) return null;
  return { projectId, workspaceId, taskId };
}

function taskKey(projectId: string, taskId: string): string {
  return `${projectId}\u0000${taskId}`;
}

function describeUrlRejection(reason: BrowserUrlRejectionReason): string {
  switch (reason) {
    case 'empty':
      return 'the URL is empty';
    case 'invalid-url':
      return 'it is not a valid URL';
    case 'unsupported-protocol':
      return 'only http, https and about:blank URLs can be opened';
    case 'unsupported-file-url':
      return 'file URLs cannot be opened in the Orkestra browser';
  }
}

async function clearPartitionBrowsingData(
  partition: string,
  kind: BrowsingDataKind
): Promise<void> {
  const partitionSession = session.fromPartition(partition);
  switch (kind) {
    case 'all':
      // No options clears every data type, more thoroughly than clearStorageData.
      await partitionSession.clearData();
      return;
    case 'cookies':
      await partitionSession.clearData({ dataTypes: ['cookies'] });
      return;
    case 'siteData':
      await partitionSession.clearData({
        dataTypes: SITE_DATA_CLEAR_DATA_TYPES,
      });
      return;
    case 'cache':
      await partitionSession.clearData({ dataTypes: ['cache'] });
      return;
  }
}

function hardenBrowserPopupWindow(window: BrowserWindow): void {
  const webContents = window.webContents;

  webContents.setWindowOpenHandler(({ url, disposition }) => {
    if (!isSupportedBrowserNavigationUrl(url)) {
      return { action: 'deny' };
    }
    if (disposition === 'new-window' && isAllowedAuthPopupUrl(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: BROWSER_POPUP_WINDOW_OPTIONS };
    }
    return { action: 'deny' };
  });

  webContents.on('did-create-window', (child) => {
    hardenBrowserPopupWindow(child);
  });

  webContents.on('will-navigate', (event, url) => {
    if (!isSupportedBrowserNavigationUrl(url)) {
      event.preventDefault();
    }
  });

  installBrowserUserAgentSwitch(webContents);
}

function installBrowserUserAgentSwitch(webContents: WebContents): void {
  // Google auth pages also probe navigator.userAgent, so the per-contents user
  // agent has to switch around auth navigations, not just the request header.
  webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    const target = userAgentForBrowserUrl(url, webContents.session.getUserAgent());
    if (webContents.getUserAgent() !== target) {
      webContents.setUserAgent(target);
    }
  });
}

function isSupportedBrowserNavigationUrl(url: string): boolean {
  return normalizeBrowserUrl(url, { allowSearchQueries: false }).ok;
}

function isExternalHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAllowedAuthPopupUrl(url: string): boolean {
  if (isGoogleAuthUrl(url)) return true;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'github.com') return false;
    return parsed.pathname === '/login' || parsed.pathname === '/login/oauth/authorize';
  } catch {
    return false;
  }
}

function getBrowserContextTarget(
  params: Electron.ContextMenuParams
): { kind: 'link' | 'image'; url: string } | null {
  if (params.mediaType === 'image' && isExternalHttpUrl(params.srcURL)) {
    return { kind: 'image', url: params.srcURL };
  }
  if (isExternalHttpUrl(params.linkURL)) return { kind: 'link', url: params.linkURL };
  return null;
}

function platformContextForBrowser(): PlatformContext {
  return {
    os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
  };
}

function getBrowserShortcutCommand(
  input: Electron.Input,
  claims: readonly BrowserClaim[]
): string | null {
  for (const claim of claims) {
    if (matchesElectronInput(input, claim.chord, platformContextForBrowser())) {
      return claim.commandId;
    }
  }
  return null;
}

function clearWebviewSelection(webContents: WebContents): void {
  if (webContents.isDestroyed()) return;
  void webContents
    .executeJavaScript('window.getSelection()?.removeAllRanges();', true)
    .catch(() => {});
}
