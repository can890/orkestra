import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserEvents } from '@core/features/browser/node';
import { desktopHostEvents } from '@core/features/workbench/node';
import type { BrowserEvent } from '@core/primitives/browser/api';
import {
  AGENT_ACTIVITY_EVENT_INTERVAL_MS,
  BrowserWebContentsRegistry,
  type BrowserWebContentsRegistryOptions,
} from './browser-webcontents-registry';

const sessionsByPartition = new Map<string, object>();

vi.mock('electron', () => ({
  session: {
    fromPartition: (partition: string) => {
      let value = sessionsByPartition.get(partition);
      if (!value) {
        value = { partition, getUserAgent: () => 'base-ua', clearData: vi.fn() };
        sessionsByPartition.set(partition, value);
      }
      return value;
    },
  },
}));

vi.mock('@core/features/browser/node', () => ({
  browserEvents: {
    emit: vi.fn(),
  },
  hasBrowserEventSubscribers: vi.fn(() => true),
}));
vi.mock('@core/features/workbench/node', () => ({
  desktopHostEvents: {
    emit: vi.fn(),
  },
}));

const PROFILE_PARTITION = 'persist:orkestra-browser-profile';

type FakeWebContents = WebContents & {
  windowOpenHandler: Parameters<WebContents['setWindowOpenHandler']>[0] | null;
  url: string;
  pageTitle: string;
  destroy(): void;
  emitEvent(event: string, ...args: unknown[]): void;
};

let nextWebContentsId = 1;

function fakeWebContents(partition: string = PROFILE_PARTITION): FakeWebContents {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  let destroyed = false;
  const fake = {
    id: nextWebContentsId++,
    session: sessionFor(partition),
    windowOpenHandler: null as FakeWebContents['windowOpenHandler'],
    url: 'https://example.com',
    pageTitle: 'Example',
    close: vi.fn(),
    isDestroyed: () => destroyed,
    getURL: () => fake.url,
    getTitle: () => fake.pageTitle,
    getUserAgent: () => 'base-ua',
    setUserAgent: vi.fn(),
    openDevTools: vi.fn(),
    setWindowOpenHandler(handler: FakeWebContents['windowOpenHandler']) {
      fake.windowOpenHandler = handler;
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return fake;
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return fake;
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((candidate) => candidate !== listener)
      );
      return fake;
    },
    destroy() {
      destroyed = true;
      for (const listener of listeners.get('destroyed') ?? []) listener();
    },
    emitEvent(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
  return fake as unknown as FakeWebContents;
}

function sessionFor(partition: string): object {
  let value = sessionsByPartition.get(partition);
  if (!value) {
    value = { partition, getUserAgent: () => 'base-ua', clearData: vi.fn() };
    sessionsByPartition.set(partition, value);
  }
  return value;
}

describe('BrowserWebContentsRegistry', () => {
  beforeEach(() => {
    sessionsByPartition.clear();
    vi.mocked(browserEvents.emit).mockClear();
    vi.mocked(desktopHostEvents.emit).mockClear();
  });

  it('closes attached webviews whose session has no registered partition', () => {
    const registry = new BrowserWebContentsRegistry();
    const webContents = fakeWebContents('persist:other');

    expect(registry.handleWebviewAttached(webContents)).toBe(false);
    expect(webContents.close).toHaveBeenCalled();
  });

  it('binds webviews on a shared partition to their browser ids explicitly', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });
    registry.registerSession({ browserId: 'browser-2', partition: PROFILE_PARTITION });

    const first = fakeWebContents();
    const second = fakeWebContents();
    expect(registry.handleWebviewAttached(first)).toBe(true);
    expect(registry.handleWebviewAttached(second)).toBe(true);

    expect(registry.bindWebContents('browser-1', first)).toBe(true);
    expect(registry.bindWebContents('browser-2', second)).toBe(true);

    expect(registry.openDevTools('browser-1')).toBe(true);
    expect(first.openDevTools).toHaveBeenCalled();
    expect(registry.getActiveBrowser()).toBe('browser-2');
  });

  it('rejects binding for unknown browsers, unattached or already-bound webContents', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });
    registry.registerSession({ browserId: 'browser-2', partition: PROFILE_PARTITION });

    const attached = fakeWebContents();
    registry.handleWebviewAttached(attached);

    expect(registry.bindWebContents('missing', attached)).toBe(false);
    expect(registry.bindWebContents('browser-1', fakeWebContents())).toBe(false);

    expect(registry.bindWebContents('browser-1', attached)).toBe(true);
    expect(registry.bindWebContents('browser-1', attached)).toBe(true);
    expect(registry.bindWebContents('browser-2', attached)).toBe(false);
  });

  it('rejects binding webContents from a different registered partition', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });
    registry.registerSession({
      browserId: 'browser-2',
      partition: 'persist:orkestra-browser-profile-work',
    });

    const attached = fakeWebContents(PROFILE_PARTITION);
    registry.handleWebviewAttached(attached);

    expect(registry.bindWebContents('browser-2', attached)).toBe(false);
    expect(registry.bindWebContents('browser-1', attached)).toBe(true);
  });

  it('allows OAuth popups as hardened windows and routes tab links in-app', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });

    const webContents = fakeWebContents();
    registry.handleWebviewAttached(webContents);
    registry.bindWebContents('browser-1', webContents);

    const handler = webContents.windowOpenHandler!;
    const popup = handler({
      url: 'https://github.com/login/oauth/authorize',
      disposition: 'new-window',
    } as Parameters<typeof handler>[0]);
    expect(popup.action).toBe('allow');
    expect(popup).toMatchObject({
      overrideBrowserWindowOptions: {
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      },
    });

    const tab = handler({
      url: 'https://example.com/docs',
      disposition: 'foreground-tab',
    } as Parameters<typeof handler>[0]);
    expect(tab.action).toBe('deny');
    expect(browserEvents.emit).toHaveBeenCalledWith(undefined, {
      type: 'open-in-new-tab',
      sourceBrowserId: 'browser-1',
      url: 'https://example.com/docs',
    });

    const windowOpen = handler({
      url: 'https://example.com/popup',
      disposition: 'new-window',
    } as Parameters<typeof handler>[0]);
    expect(windowOpen.action).toBe('deny');
    expect(browserEvents.emit).toHaveBeenCalledWith(undefined, {
      type: 'open-in-new-tab',
      sourceBrowserId: 'browser-1',
      url: 'https://example.com/popup',
    });

    const blocked = handler({
      url: 'javascript:alert(1)',
      disposition: 'new-window',
    } as Parameters<typeof handler>[0]);
    expect(blocked.action).toBe('deny');
  });

  it('switches popup webContents user agent during Google auth navigations', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });
    const webContents = fakeWebContents();
    const popupWebContents = fakeWebContents();

    registry.handleWebviewAttached(webContents);
    webContents.emitEvent('did-create-window', { webContents: popupWebContents });
    popupWebContents.emitEvent(
      'did-start-navigation',
      {},
      'https://accounts.google.com/signin',
      false,
      true
    );

    expect(popupWebContents.setUserAgent).toHaveBeenCalledWith(
      expect.stringContaining('Firefox/140.0')
    );
  });

  it('cleans up bindings when the webContents is destroyed', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });

    const webContents = fakeWebContents();
    registry.handleWebviewAttached(webContents);
    registry.bindWebContents('browser-1', webContents);
    expect(registry.getActiveBrowser()).toBe('browser-1');

    webContents.destroy();

    expect(registry.getActiveBrowser()).toBeNull();
    expect(registry.openDevTools('browser-1')).toBe(false);
  });

  it('emits tab navigation shortcuts from focused browser webContents', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });

    const webContents = fakeWebContents();
    registry.handleWebviewAttached(webContents);
    registry.bindWebContents('browser-1', webContents);

    const keyEvent = { preventDefault: vi.fn() };
    webContents.emitEvent('before-input-event', keyEvent, {
      type: 'keyDown',
      key: 'Tab',
      control: true,
      shift: true,
      alt: false,
      meta: false,
    });

    expect(keyEvent.preventDefault).toHaveBeenCalled();
    expect(desktopHostEvents.emit).toHaveBeenCalledWith(undefined, {
      type: 'tab-navigation-shortcut',
      source: { kind: 'browser', browserId: 'browser-1' },
      direction: 'previous',
    });
  });

  it('emits app shortcuts from focused browser webContents', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });

    const webContents = fakeWebContents();
    registry.handleWebviewAttached(webContents);
    registry.bindWebContents('browser-1', webContents);

    const keyEvent = { preventDefault: vi.fn() };
    webContents.emitEvent('before-input-event', keyEvent, {
      type: 'keyDown',
      key: 'K',
      control: process.platform !== 'darwin',
      shift: false,
      alt: false,
      meta: process.platform === 'darwin',
    });

    expect(keyEvent.preventDefault).toHaveBeenCalled();
    expect(desktopHostEvents.emit).toHaveBeenCalledWith(undefined, {
      type: 'browser-app-shortcut',
      source: { kind: 'browser', browserId: 'browser-1' },
      commandId: 'app.commandPalette',
    });
  });

  it('does not emit disabled app shortcuts from focused browser webContents', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.setKeyboardSettings({ commandPalette: null });
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });

    const webContents = fakeWebContents();
    registry.handleWebviewAttached(webContents);
    registry.bindWebContents('browser-1', webContents);

    const keyEvent = { preventDefault: vi.fn() };
    webContents.emitEvent('before-input-event', keyEvent, {
      type: 'keyDown',
      key: 'K',
      control: process.platform !== 'darwin',
      shift: false,
      alt: false,
      meta: process.platform === 'darwin',
    });

    expect(keyEvent.preventDefault).not.toHaveBeenCalled();
    expect(desktopHostEvents.emit).not.toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ type: 'browser-app-shortcut' })
    );
  });

  it('does not claim text-input-gated shortcuts from browser webContents', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });

    const webContents = fakeWebContents();
    registry.handleWebviewAttached(webContents);
    registry.bindWebContents('browser-1', webContents);

    const keyEvent = { preventDefault: vi.fn() };
    webContents.emitEvent('before-input-event', keyEvent, {
      type: 'keyDown',
      key: 'Backspace',
      control: process.platform !== 'darwin',
      shift: false,
      alt: false,
      meta: process.platform === 'darwin',
    });

    expect(keyEvent.preventDefault).not.toHaveBeenCalled();
    expect(desktopHostEvents.emit).not.toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ type: 'browser-app-shortcut' })
    );
  });

  it('does not consume Escape in focused browser webContents', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });

    const webContents = fakeWebContents();
    registry.handleWebviewAttached(webContents);
    registry.bindWebContents('browser-1', webContents);

    const keyEvent = { preventDefault: vi.fn() };
    webContents.emitEvent('before-input-event', keyEvent, {
      type: 'keyDown',
      key: 'Escape',
      control: false,
      shift: false,
      alt: false,
      meta: false,
    });

    expect(keyEvent.preventDefault).not.toHaveBeenCalled();
    expect(desktopHostEvents.emit).not.toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ type: 'browser-app-shortcut' })
    );
  });

  it('does not consume shortcuts ignored in focused browser webContents', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });

    const webContents = fakeWebContents();
    registry.handleWebviewAttached(webContents);
    registry.bindWebContents('browser-1', webContents);

    const keyEvent = { preventDefault: vi.fn() };
    webContents.emitEvent('before-input-event', keyEvent, {
      type: 'keyDown',
      key: 'Z',
      control: true,
      shift: false,
      alt: false,
      meta: false,
    });

    expect(keyEvent.preventDefault).not.toHaveBeenCalled();
    expect(desktopHostEvents.emit).not.toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ type: 'browser-app-shortcut' })
    );
  });

  it('clears storage for a named profile without requiring an open browser', async () => {
    const registry = new BrowserWebContentsRegistry();

    await expect(registry.clearProfileStorage('work')).resolves.toBe(true);
    await expect(registry.clearProfileStorage('isolated-per-task')).resolves.toBe(false);

    const profileSession = sessionsByPartition.get('persist:orkestra-browser-profile-work') as
      | { clearData: ReturnType<typeof vi.fn> }
      | undefined;
    expect(profileSession?.clearData).toHaveBeenCalled();
  });

  it('clears the requested browsing data category across every passed partition', async () => {
    const registry = new BrowserWebContentsRegistry();
    const partitions = [PROFILE_PARTITION, 'persist:orkestra-browser-profile-work'];

    await expect(registry.clearBrowsingData('cache', partitions)).resolves.toBe(true);

    for (const partition of partitions) {
      const partitionSession = sessionsByPartition.get(partition) as
        | { clearData: ReturnType<typeof vi.fn> }
        | undefined;
      expect(partitionSession?.clearData).toHaveBeenCalledWith({ dataTypes: ['cache'] });
    }
  });

  it('passes no options for an "all" clear and dataTypes for other categories', async () => {
    const registry = new BrowserWebContentsRegistry();

    await registry.clearBrowsingData('all', [PROFILE_PARTITION]);
    await registry.clearBrowsingData('cookies', [PROFILE_PARTITION]);
    await registry.clearBrowsingData('siteData', [PROFILE_PARTITION]);

    const partitionSession = sessionsByPartition.get(PROFILE_PARTITION) as {
      clearData: ReturnType<typeof vi.fn>;
    };
    expect(partitionSession.clearData).toHaveBeenNthCalledWith(1);
    expect(partitionSession.clearData).toHaveBeenNthCalledWith(2, { dataTypes: ['cookies'] });
    expect(partitionSession.clearData).toHaveBeenNthCalledWith(3, {
      dataTypes: [
        'backgroundFetch',
        'cacheStorage',
        'fileSystems',
        'indexedDB',
        'localStorage',
        'serviceWorkers',
        'webSQL',
      ],
    });
  });
});

const TASK = { projectId: 'project-1', workspaceId: 'workspace-1', taskId: 'task-1' };

function agentRegistry(options: BrowserWebContentsRegistryOptions = {}) {
  const events: BrowserEvent[] = [];
  const registry = new BrowserWebContentsRegistry({
    emit: (event) => events.push(event),
    hasRenderer: () => true,
    ...options,
  });
  return { registry, events };
}

function registerTaskBrowser(
  registry: BrowserWebContentsRegistry,
  browserId: string,
  identity: Partial<typeof TASK> = TASK
): void {
  registry.registerSession({ browserId, partition: PROFILE_PARTITION, ...identity });
}

function bindLive(registry: BrowserWebContentsRegistry, browserId: string): FakeWebContents {
  const webContents = fakeWebContents();
  registry.handleWebviewAttached(webContents);
  expect(registry.bindWebContents(browserId, webContents)).toBe(true);
  return webContents;
}

function lastRequestId(events: BrowserEvent[]): string {
  const event = events.at(-1);
  if (!event || !('requestId' in event)) throw new Error('No agent request was emitted');
  return event.requestId;
}

describe('BrowserWebContentsRegistry task identity', () => {
  it('lists the tabs of a task with identity, page state and liveness', () => {
    const { registry } = agentRegistry();
    registry.registerSession({
      browserId: 'browser-1',
      partition: PROFILE_PARTITION,
      ...TASK,
      url: 'https://restored.example/',
      title: 'Restored',
    });
    registerTaskBrowser(registry, 'browser-2');
    registerTaskBrowser(registry, 'other-task', { ...TASK, taskId: 'task-2' });
    registry.registerSession({ browserId: 'anonymous', partition: PROFILE_PARTITION });

    bindLive(registry, 'browser-2');

    expect(registry.listTabs({ projectId: 'project-1', taskId: 'task-1' })).toEqual([
      {
        browserId: 'browser-1',
        ...TASK,
        url: 'https://restored.example/',
        title: 'Restored',
        active: false,
        live: false,
      },
      {
        browserId: 'browser-2',
        ...TASK,
        url: 'https://example.com',
        title: 'Example',
        active: false,
        live: true,
      },
    ]);
    expect(registry.getTab('other-task')).toMatchObject({ taskId: 'task-2' });
    expect(registry.getTab('anonymous')).toBeNull();
    expect(registry.getTab('missing')).toBeNull();
  });

  it('keeps identity when a session re-registers without it', () => {
    const { registry } = agentRegistry();
    registerTaskBrowser(registry, 'browser-1');
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });

    expect(registry.getTab('browser-1')).toMatchObject(TASK);
  });

  it('tracks the url and title of the bound page', () => {
    const { registry } = agentRegistry();
    registerTaskBrowser(registry, 'browser-1');
    const webContents = bindLive(registry, 'browser-1');

    webContents.emitEvent('did-navigate', {}, 'https://example.com/next', 200, 'OK');
    webContents.emitEvent('page-title-updated', {}, 'Next page', true);
    expect(registry.getTab('browser-1')).toMatchObject({
      url: 'https://example.com/next',
      title: 'Next page',
    });

    webContents.emitEvent('did-navigate-in-page', {}, 'https://frame.example/', false, 1, 2);
    expect(registry.getTab('browser-1')?.url).toBe('https://example.com/next');

    webContents.emitEvent('did-navigate-in-page', {}, 'https://example.com/next#top', true, 1, 1);
    expect(registry.getTab('browser-1')?.url).toBe('https://example.com/next#top');
  });

  it('reports a tab as not live once its page is destroyed', () => {
    const { registry } = agentRegistry();
    registerTaskBrowser(registry, 'browser-1');
    const webContents = bindLive(registry, 'browser-1');
    const released = vi.fn();
    registry.onBrowserReleased(released);

    webContents.destroy();

    expect(registry.getTab('browser-1')?.live).toBe(false);
    expect(registry.getLiveWebContents('browser-1')).toBeNull();
    expect(released).toHaveBeenCalledWith('browser-1');
  });

  it('releases the page binding when a profile switch moves the session to another partition', () => {
    const { registry } = agentRegistry();
    registerTaskBrowser(registry, 'browser-1');
    bindLive(registry, 'browser-1');
    const released = vi.fn();
    registry.onBrowserReleased(released);

    registry.registerSession({
      browserId: 'browser-1',
      partition: 'persist:orkestra-browser-profile-work',
      ...TASK,
    });

    expect(released).toHaveBeenCalledWith('browser-1');
    expect(registry.getTab('browser-1')?.live).toBe(false);
  });
});

describe('BrowserWebContentsRegistry active tabs per task', () => {
  it('marks the front tabs of each task without touching the global active browser', () => {
    const { registry } = agentRegistry();
    registerTaskBrowser(registry, 'browser-1');
    registerTaskBrowser(registry, 'browser-2');
    registerTaskBrowser(registry, 'browser-3', { ...TASK, taskId: 'task-2' });
    registry.setActiveBrowser('browser-3');

    registry.syncTaskActiveBrowsers([
      { projectId: 'project-1', taskId: 'task-1', browserIds: ['browser-2'] },
      { projectId: 'project-1', taskId: 'task-2', browserIds: ['browser-3'] },
    ]);

    expect(registry.getTab('browser-1')?.active).toBe(false);
    expect(registry.getTab('browser-2')?.active).toBe(true);
    expect(registry.getTab('browser-3')?.active).toBe(true);
    expect(registry.getActiveBrowser()).toBe('browser-3');

    registry.syncTaskActiveBrowsers([
      { projectId: 'project-1', taskId: 'task-1', browserIds: ['browser-1'] },
    ]);

    expect(registry.getTab('browser-1')?.active).toBe(true);
    expect(registry.getTab('browser-2')?.active).toBe(false);
    expect(registry.getTab('browser-3')?.active).toBe(false);
  });
});

describe('BrowserWebContentsRegistry agent tab requests', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a tab through the renderer and resolves once its page is bound', async () => {
    const { registry, events } = agentRegistry();
    let settled = false;

    const opened = registry
      .requestOpenTab({ ...TASK, url: 'localhost:5173/app', activate: false })
      .finally(() => {
        settled = true;
      });

    expect(events).toEqual([
      {
        type: 'open-requested',
        requestId: expect.any(String),
        ...TASK,
        url: 'http://localhost:5173/app',
        activate: false,
      },
    ]);

    expect(
      registry.resolveAgentRequest({
        requestId: lastRequestId(events),
        ok: true,
        browserId: 'browser-1',
      })
    ).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);

    registerTaskBrowser(registry, 'browser-1');
    await Promise.resolve();
    expect(settled).toBe(false);

    bindLive(registry, 'browser-1');

    await expect(opened).resolves.toMatchObject({ browserId: 'browser-1', ...TASK, live: true });
  });

  it('resolves immediately when the page is already bound before the renderer answers', async () => {
    const { registry, events } = agentRegistry();
    const opened = registry.requestOpenTab(TASK);
    expect(events[0]).toMatchObject({ type: 'open-requested', activate: true });
    expect(events[0]).not.toHaveProperty('url');

    registerTaskBrowser(registry, 'browser-1');
    bindLive(registry, 'browser-1');
    registry.resolveAgentRequest({
      requestId: lastRequestId(events),
      ok: true,
      browserId: 'browser-1',
    });

    await expect(opened).resolves.toMatchObject({ browserId: 'browser-1', live: true });
  });

  it('rejects immediately without a renderer, without identity or for unsupported URLs', async () => {
    const { registry, events } = agentRegistry({ hasRenderer: () => false });

    await expect(registry.requestOpenTab(TASK)).rejects.toThrow(/window is not open/);
    await expect(registry.requestOpenTab({ ...TASK, taskId: ' ' })).rejects.toThrow(
      /taskId are required/
    );
    await expect(registry.requestOpenTab({ ...TASK, url: 'javascript:alert(1)' })).rejects.toThrow(
      /only http, https and about:blank/
    );
    await expect(registry.requestOpenTab({ ...TASK, url: 'file:///etc/passwd' })).rejects.toThrow(
      /file URLs cannot be opened/
    );
    expect(events).toEqual([]);
  });

  it('rejects with the renderer error message', async () => {
    const { registry, events } = agentRegistry();
    const opened = registry.requestOpenTab(TASK);

    registry.resolveAgentRequest({
      requestId: lastRequestId(events),
      ok: false,
      error: 'Task task-1 is not available',
    });

    await expect(opened).rejects.toThrow('Task task-1 is not available');
    expect(registry.resolveAgentRequest({ requestId: 'unknown', ok: true })).toBe(false);
  });

  it('times out when the tab does not become live', async () => {
    vi.useFakeTimers();
    const { registry, events } = agentRegistry({ requestTimeoutMs: 20_000 });
    const opened = registry.requestOpenTab(TASK);
    const assertion = expect(opened).rejects.toThrow(
      'Timed out after 20 s waiting for the Orkestra window to open the browser tab.'
    );

    registry.resolveAgentRequest({
      requestId: lastRequestId(events),
      ok: true,
      browserId: 'browser-1',
    });
    await vi.advanceTimersByTimeAsync(20_000);

    await assertion;
  });

  it('rejects a pending open when its tab closes before it is bound', async () => {
    const { registry, events } = agentRegistry();
    const opened = registry.requestOpenTab(TASK);
    registry.resolveAgentRequest({
      requestId: lastRequestId(events),
      ok: true,
      browserId: 'browser-1',
    });
    registerTaskBrowser(registry, 'browser-1');

    registry.unregisterSession('browser-1');

    await expect(opened).rejects.toThrow(/closed before the request completed/);
  });

  it('drops stale sessions and pending requests when a new renderer syncs', async () => {
    const { registry, events } = agentRegistry();
    registerTaskBrowser(registry, 'stale');
    registerTaskBrowser(registry, 'kept');
    const opened = registry.requestOpenTab(TASK);

    registry.syncSessions(['kept']);

    await expect(opened).rejects.toThrow(/reloaded before the browser tab request completed/);
    expect(registry.getTab('stale')).toBeNull();
    expect(registry.getTab('kept')).not.toBeNull();
    expect(registry.registeredPartitions.size).toBe(1);
    expect(events).toHaveLength(1);
  });

  it('activates a tab through the renderer and reports it active', async () => {
    const { registry, events } = agentRegistry();
    registerTaskBrowser(registry, 'browser-1');

    const activated = registry.requestActivateTab('browser-1');
    expect(events.at(-1)).toEqual({
      type: 'activate-requested',
      requestId: expect.any(String),
      browserId: 'browser-1',
    });
    registry.resolveAgentRequest({ requestId: lastRequestId(events), ok: true });

    await expect(activated).resolves.toBeUndefined();
    expect(registry.getTab('browser-1')?.active).toBe(true);
  });

  it('closes a tab through the renderer and forgets it', async () => {
    const { registry, events } = agentRegistry();
    registerTaskBrowser(registry, 'browser-1');
    bindLive(registry, 'browser-1');
    const released = vi.fn();
    registry.onBrowserReleased(released);

    const closed = registry.requestCloseTab('browser-1');
    expect(events.at(-1)).toMatchObject({ type: 'close-requested', browserId: 'browser-1' });
    registry.resolveAgentRequest({ requestId: lastRequestId(events), ok: true });

    await expect(closed).resolves.toBeUndefined();
    expect(registry.getTab('browser-1')).toBeNull();
    expect(released).toHaveBeenCalledWith('browser-1');
  });

  it('rejects activate and close requests for unknown tabs or without a renderer', async () => {
    const { registry } = agentRegistry();
    await expect(registry.requestActivateTab('missing')).rejects.toThrow(
      'Unknown browser tab: missing'
    );
    await expect(registry.requestCloseTab('missing')).rejects.toThrow(
      'Unknown browser tab: missing'
    );

    const offline = agentRegistry({ hasRenderer: () => false });
    registerTaskBrowser(offline.registry, 'browser-1');
    await expect(offline.registry.requestCloseTab('browser-1')).rejects.toThrow(
      /window is not open/
    );
  });

  it('times out activate requests the renderer never answers', async () => {
    vi.useFakeTimers();
    const { registry } = agentRegistry({ requestTimeoutMs: 1_000 });
    registerTaskBrowser(registry, 'browser-1');
    const activated = registry.requestActivateTab('browser-1');
    const assertion = expect(activated).rejects.toThrow(
      'Timed out after 1 s waiting for the Orkestra window to activate the browser tab.'
    );

    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
  });

  it('throttles agent activity events per tab', () => {
    let now = 1_000;
    const { registry, events } = agentRegistry({ now: () => now });
    registerTaskBrowser(registry, 'browser-1');

    registry.markAgentActivity('browser-1');
    registry.markAgentActivity('browser-1');
    registry.markAgentActivity('missing');
    now += AGENT_ACTIVITY_EVENT_INTERVAL_MS;
    registry.markAgentActivity('browser-1');

    expect(events).toEqual([
      { type: 'agent-activity', browserId: 'browser-1', at: 1_000 },
      {
        type: 'agent-activity',
        browserId: 'browser-1',
        at: 1_000 + AGENT_ACTIVITY_EVENT_INTERVAL_MS,
      },
    ]);
  });
});
