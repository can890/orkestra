import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  session,
  type BrowserWindowConstructorOptions,
  type ClearDataOptions,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import type {
  BrowserPickedElement,
  BrowserPickElementResult,
} from '@core/features/browser/api';
import { browserEvents, hasBrowserEventSubscribers } from '@core/features/browser/node';
import type { BrowserSessionRegistration } from '@core/features/browser/node/wire-controller';
import { desktopHostEvents } from '@core/features/workbench/node';
import { buildBrowserClaims, type BrowserClaim } from '@core/manifests/shared/browser-claims';
import {
  BROWSER_DEFAULT_URL,
  BROWSER_AGENT_PROFILE_ID,
  BROWSER_AGENT_PROFILE_PARTITION,
  browserProfilePartition,
  isNamedBrowserProfileId,
  normalizeBrowserUrl,
  type BrowserAgentRequestReply,
  type BrowserColorScheme,
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
import { isAutomationInputActive } from './automation/synthetic-input';
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
  audioMuted?: boolean;
};

type PipWindowState = {
  window: BrowserWindow;
  timer: ReturnType<typeof setInterval> | null;
  lastCrc: number | undefined;
  inFlight: boolean;
};

const PIP_FRAME_INTERVAL_MS = 84;
const PIP_JPEG_QUALITY = 80;

function buildPipHtml(): string {
  const html = [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\';">',
    '<style>html,body{margin:0;padding:0;width:100%;height:100%;background:#111111;overflow:hidden;display:flex;align-items:center;justify-content:center}#frame{width:100%;height:100%;object-fit:contain;display:block;-webkit-user-drag:none}</style>',
    '</head><body><img id="frame" alt=""></body></html>',
  ].join('');
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

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
  private readonly pipWindowsByBrowserId = new Map<string, PipWindowState>();
  private readonly colorSchemeByBrowserId = new Map<string, BrowserColorScheme>();
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

  markHumanInputByWebContentsId(webContentsId: number): void {
    const browserId = this.browserIdByWebContentsId.get(webContentsId);
    if (!browserId) return;
    this.emitEvent({ type: 'controller-changed', browserId, controller: 'user' });
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
    this.closePipWindow(browserId);
    this.colorSchemeByBrowserId.delete(browserId);
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
    if (registered.audioMuted !== undefined && typeof webContents.setAudioMuted === 'function') {
      webContents.setAudioMuted(registered.audioMuted);
    }
    const savedScheme = this.colorSchemeByBrowserId.get(browserId);
    if (savedScheme && savedScheme !== 'system') {
      void this.applyColorScheme(webContents, savedScheme);
    }
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

  async pickElement(browserId: string): Promise<BrowserPickElementResult> {
    const webContents = this.webContentsByBrowserId.get(browserId);
    if (!webContents || webContents.isDestroyed()) {
      return { success: false, error: 'Önizleme sekmesi henüz yüklenmedi.' };
    }
    try {
      const script = `(() => {
        if (typeof window.__orkestraCancelElementPicker === 'function') {
          window.__orkestraCancelElementPicker();
        }
        return new Promise((resolve) => {
          const OVERLAY_ID = '__orkestra_element_picker_overlay__';
          const LABEL_ID = '__orkestra_element_picker_label__';
          const overlay = document.createElement('div');
          overlay.id = OVERLAY_ID;
          overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #38bdf8;background:rgba(56,189,248,0.14);border-radius:4px;transition:all 40ms ease;display:none;';
          const label = document.createElement('div');
          label.id = LABEL_ID;
          label.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#0f172a;color:#f8fafc;font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 6px;border-radius:4px;border:1px solid rgba(56,189,248,0.45);box-shadow:0 4px 12px rgba(0,0,0,0.35);max-width:340px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none;';
          document.documentElement.appendChild(overlay);
          document.documentElement.appendChild(label);
          const prevCursor = document.documentElement.style.cursor;
          document.documentElement.style.cursor = 'crosshair';

          function buildSelector(el) {
            if (!el || el.nodeType !== 1) return '';
            if (el.id) return '#' + CSS.escape(el.id);
            const parts = [];
            let cur = el;
            while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
              let part = cur.tagName.toLowerCase();
              const cls = Array.from(cur.classList || []).filter((c) => c && !c.startsWith('__orkestra')).slice(0, 2);
              if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');
              const parent = cur.parentElement;
              if (parent) {
                const same = Array.from(parent.children).filter((s) => s.tagName === cur.tagName);
                if (same.length > 1) {
                  part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
                }
              }
              parts.unshift(part);
              if (parts.length >= 5) break;
              cur = parent;
            }
            return parts.join(' > ');
          }

          let settled = false;
          function cleanup() {
            window.removeEventListener('mousemove', onMove, true);
            window.removeEventListener('click', onClick, true);
            window.removeEventListener('keydown', onKeyDown, true);
            overlay.remove();
            label.remove();
            document.documentElement.style.cursor = prevCursor;
            delete window.__orkestraCancelElementPicker;
          }

          function finish(payload) {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(payload);
          }

          window.__orkestraCancelElementPicker = () => finish({ cancelled: true });

          function onMove(e) {
            const target = document.elementFromPoint(e.clientX, e.clientY);
            if (!target || target === overlay || target === label || target === document.documentElement) {
              overlay.style.display = 'none';
              label.style.display = 'none';
              return;
            }
            const rect = target.getBoundingClientRect();
            overlay.style.display = 'block';
            overlay.style.left = rect.left + 'px';
            overlay.style.top = rect.top + 'px';
            overlay.style.width = rect.width + 'px';
            overlay.style.height = rect.height + 'px';
            const tag = target.tagName.toLowerCase();
            const idPart = target.id ? '#' + target.id : '';
            const cls = Array.from(target.classList || []).slice(0, 2).map((c) => '.' + c).join('');
            label.textContent = tag + idPart + cls + ' (' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ')';
            label.style.display = 'block';
            label.style.left = Math.max(6, Math.min(window.innerWidth - 346, rect.left)) + 'px';
            label.style.top = Math.max(6, rect.top > 28 ? rect.top - 24 : rect.bottom + 4) + 'px';
          }

          function onKeyDown(e) {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              finish({ cancelled: true });
            }
          }

          function onClick(e) {
            const target = document.elementFromPoint(e.clientX, e.clientY);
            e.preventDefault();
            e.stopPropagation();
            if (!target || target === overlay || target === label) {
              finish({ cancelled: true });
              return;
            }
            const rect = target.getBoundingClientRect();
            const cs = window.getComputedStyle(target);
            const styles = {
              display: cs.display,
              position: cs.position,
              color: cs.color,
              backgroundColor: cs.backgroundColor,
              fontFamily: cs.fontFamily,
              fontSize: cs.fontSize,
              padding: cs.padding,
              margin: cs.margin,
              borderRadius: cs.borderRadius,
            };
            const element = {
              selector: buildSelector(target),
              tagName: target.tagName.toLowerCase(),
              id: target.id || '',
              classes: Array.from(target.classList || []).slice(0, 12),
              textSnippet: (target.innerText || target.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 220),
              outerHtmlSnippet: (target.outerHTML || '').slice(0, 600),
              rect: {
                x: Math.max(0, Math.round(rect.left)),
                y: Math.max(0, Math.round(rect.top)),
                width: Math.max(1, Math.round(rect.width)),
                height: Math.max(1, Math.round(rect.height)),
              },
              computedStyles: styles,
              pageUrl: window.location.href,
              pageTitle: document.title || '',
            };
            finish({ cancelled: false, element });
          }

          window.addEventListener('mousemove', onMove, true);
          window.addEventListener('click', onClick, true);
          window.addEventListener('keydown', onKeyDown, true);
        });
      })()`;

      const picked = (await webContents.executeJavaScript(script, true)) as {
        cancelled?: boolean;
        element?: BrowserPickedElement;
      };
      if (!picked || picked.cancelled || !picked.element) {
        return { success: true, cancelled: true };
      }

      const el = picked.element;
      let screenshotBase64: string | undefined;
      try {
        // Overlay'in DOM'dan tamamen silinmesi için 1 kare bekle, sonra öğe bölgesini yakala.
        await new Promise((r) => setTimeout(r, 40));
        const pad = 12;
        const captureRect = {
          x: Math.max(0, el.rect.x - pad),
          y: Math.max(0, el.rect.y - pad),
          width: Math.min(1600, Math.max(40, el.rect.width + pad * 2)),
          height: Math.min(1200, Math.max(40, el.rect.height + pad * 2)),
        };
        const image = await webContents.capturePage(captureRect);
        if (!image.isEmpty()) {
          screenshotBase64 = image.toPNG().toString('base64');
        }
      } catch {
        // Kırpılmış yakalama başarısız olursa sessizce metin bağlamıyla devam et.
      }

      return {
        success: true,
        element: {
          ...el,
          ...(screenshotBase64 ? { screenshotBase64 } : {}),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Öğe seçimi başarısız oldu.',
      };
    }
  }

  async cancelPickElement(browserId: string): Promise<boolean> {
    const webContents = this.webContentsByBrowserId.get(browserId);
    if (!webContents || webContents.isDestroyed()) return false;
    try {
      await webContents.executeJavaScript(
        'if (typeof window.__orkestraCancelElementPicker === "function") window.__orkestraCancelElementPicker();',
        true
      );
      return true;
    } catch {
      return false;
    }
  }

  emitAgentPointer(
    browserId: string,
    pointer: { x: number; y: number; action: 'move' | 'click' }
  ): void {
    if (!this.sessionsByBrowserId.has(browserId)) return;
    this.emitEvent({
      type: 'agent-pointer',
      browserId,
      x: pointer.x,
      y: pointer.y,
      action: pointer.action,
      at: this.now(),
    });
  }

  // Adapted from pingdotgg/t3code (MIT) — 12 fps frame-stream PiP window with crc32 deduplication
  // so OAuth/state/playback inside the live webview continues without reloading the URL.
  async openPipWindow(browserId: string): Promise<{ success: boolean; error?: string }> {
    const record = this.sessionsByBrowserId.get(browserId);
    const liveWebContents = this.webContentsByBrowserId.get(browserId);
    if (!record || !liveWebContents || liveWebContents.isDestroyed()) {
      return { success: false, error: 'Yüzen önizleme için açık bir tarayıcı sekmesi yok.' };
    }

    const existing = this.pipWindowsByBrowserId.get(browserId);
    if (existing && !existing.window.isDestroyed()) {
      existing.window.show();
      existing.window.focus();
      this.emitEvent({ type: 'pip-state-changed', browserId, open: true });
      return { success: true };
    }

    const preloadPath =
      typeof app?.getAppPath === 'function'
        ? join(app.getAppPath(), 'out', 'preload', 'browser-pip-preload.cjs')
        : '';

    const pipWindow = new BrowserWindow({
      width: 480,
      height: 320,
      minWidth: 240,
      minHeight: 160,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      backgroundColor: '#111111',
      title: `Sovra · Yüzen Pencere${record.title ? ` — ${record.title}` : ''}`,
      webPreferences: {
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        ...(preloadPath ? { preload: preloadPath } : {}),
      },
    });
    hardenBrowserPopupWindow(pipWindow);

    const pipState: PipWindowState = {
      window: pipWindow,
      timer: null,
      lastCrc: undefined,
      inFlight: false,
    };

    const pumpFrame = async () => {
      if (pipState.inFlight) return;
      const wc = this.webContentsByBrowserId.get(browserId);
      if (!wc || wc.isDestroyed() || pipWindow.isDestroyed()) return;
      pipState.inFlight = true;
      try {
        const image = await wc.capturePage();
        if (pipWindow.isDestroyed() || wc.isDestroyed() || image.isEmpty()) return;
        const bitmap = image.toBitmap();
        const nextCrc = crc32(bitmap);
        if (nextCrc === pipState.lastCrc) return;
        pipState.lastCrc = nextCrc;
        const dataUrl = `data:image/jpeg;base64,${image.toJPEG(PIP_JPEG_QUALITY).toString('base64')}`;
        pipWindow.webContents.send('orkestra:pip-frame', { dataUrl });
      } catch {
        // Kapanma sırasındaki geçici yakalama hataları bir sonraki karede düzelir.
      } finally {
        pipState.inFlight = false;
      }
    };

    this.pipWindowsByBrowserId.set(browserId, pipState);
    pipWindow.on('closed', () => {
      if (pipState.timer) {
        clearInterval(pipState.timer);
        pipState.timer = null;
      }
      if (this.pipWindowsByBrowserId.get(browserId) === pipState) {
        this.pipWindowsByBrowserId.delete(browserId);
      }
      this.emitEvent({ type: 'pip-state-changed', browserId, open: false });
    });

    await pipWindow.loadURL(buildPipHtml());
    if (!pipWindow.isDestroyed()) {
      void pumpFrame();
      pipState.timer = setInterval(() => void pumpFrame(), PIP_FRAME_INTERVAL_MS);
      pipState.timer.unref?.();
      this.emitEvent({ type: 'pip-state-changed', browserId, open: true });
    }
    return { success: true };
  }

  closePipWindow(browserId: string): boolean {
    const pipState = this.pipWindowsByBrowserId.get(browserId);
    if (!pipState) return false;
    if (pipState.timer) {
      clearInterval(pipState.timer);
      pipState.timer = null;
    }
    this.pipWindowsByBrowserId.delete(browserId);
    if (!pipState.window.isDestroyed()) {
      pipState.window.close();
    } else {
      this.emitEvent({ type: 'pip-state-changed', browserId, open: false });
    }
    return true;
  }

  findInPage(
    browserId: string,
    text: string,
    options?: { forward?: boolean; matchCase?: boolean; findNext?: boolean }
  ): boolean {
    const wc = this.webContentsByBrowserId.get(browserId);
    if (!wc || wc.isDestroyed() || typeof wc.findInPage !== 'function') return false;
    const query = text.trim();
    if (!query) {
      wc.stopFindInPage?.('clearSelection');
      this.emitEvent({
        type: 'find-result',
        browserId,
        activeMatchOrdinal: 0,
        matches: 0,
        finalUpdate: true,
      });
      return true;
    }
    wc.findInPage(text, {
      forward: options?.forward ?? true,
      matchCase: options?.matchCase ?? false,
      findNext: options?.findNext ?? false,
    });
    return true;
  }

  stopFindInPage(
    browserId: string,
    action: 'clearSelection' | 'keepSelection' | 'activateSelection' = 'clearSelection'
  ): boolean {
    const wc = this.webContentsByBrowserId.get(browserId);
    if (!wc || wc.isDestroyed() || typeof wc.stopFindInPage !== 'function') return false;
    wc.stopFindInPage(action);
    return true;
  }

  setAudioMuted(browserId: string, muted: boolean): boolean {
    const registered = this.sessionsByBrowserId.get(browserId);
    if (!registered) return false;
    registered.audioMuted = muted;
    const wc = this.webContentsByBrowserId.get(browserId);
    if (wc && !wc.isDestroyed() && typeof wc.setAudioMuted === 'function') {
      wc.setAudioMuted(muted);
    }
    const audible = wc && !wc.isDestroyed() ? (wc.isCurrentlyAudible?.() ?? false) : false;
    this.emitEvent({ type: 'audio-state-changed', browserId, audible, muted });
    return true;
  }

  async setColorScheme(browserId: string, colorScheme: BrowserColorScheme): Promise<boolean> {
    if (!this.sessionsByBrowserId.has(browserId)) return false;
    this.colorSchemeByBrowserId.set(browserId, colorScheme);
    const wc = this.webContentsByBrowserId.get(browserId);
    if (!wc || wc.isDestroyed()) return true;
    return this.applyColorScheme(wc, colorScheme);
  }

  private async applyColorScheme(
    wc: WebContents,
    colorScheme: BrowserColorScheme
  ): Promise<boolean> {
    if (!wc.debugger) return false;
    const features =
      colorScheme === 'system' ? [] : [{ name: 'prefers-color-scheme', value: colorScheme }];
    try {
      if (!wc.debugger.isAttached()) {
        if (colorScheme === 'system') return true;
        wc.debugger.attach('1.3');
      }
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features });
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
    if (profileId === BROWSER_AGENT_PROFILE_ID) {
      await session.fromPartition(BROWSER_AGENT_PROFILE_PARTITION).clearData();
      return true;
    }
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
    webContents.on('media-started-playing', () => {
      const browserId = this.browserIdByWebContentsId.get(webContents.id);
      if (!browserId) return;
      this.emitEvent({
        type: 'audio-state-changed',
        browserId,
        audible: true,
        muted: webContents.isAudioMuted?.() ?? false,
      });
    });
    webContents.on('media-paused', () => {
      const browserId = this.browserIdByWebContentsId.get(webContents.id);
      if (!browserId) return;
      this.emitEvent({
        type: 'audio-state-changed',
        browserId,
        audible: false,
        muted: webContents.isAudioMuted?.() ?? false,
      });
    });
    webContents.on('found-in-page', (_event, result) => {
      const browserId = this.browserIdByWebContentsId.get(webContents.id);
      if (!browserId || !result) return;
      this.emitEvent({
        type: 'find-result',
        browserId,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
        finalUpdate: result.finalUpdate,
      });
    });
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
      // Ajanın gönderdiği sentetik tuşlar uygulama kısayollarını tetiklememeli.
      if (isAutomationInputActive(webContents)) return;
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
      // Ajanın sağ tıkı kullanıcının ekranında menü açmamalı.
      if (isAutomationInputActive(webContents)) return;
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
