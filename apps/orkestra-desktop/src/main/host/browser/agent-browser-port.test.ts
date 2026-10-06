import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserEvent } from '@core/primitives/browser/api';
import { agentBrowserPort, createAgentBrowserPort } from './agent-browser-port';
import { createPageAutomation, type MainPageAutomation } from './automation/page-automation';
import { BrowserWebContentsRegistry } from './browser-webcontents-registry';

const PROFILE_PARTITION = 'persist:orkestra-browser-profile';
const sessionsByPartition = new Map<string, object>();

vi.mock('electron', () => ({
  session: {
    fromPartition: (partition: string) => sessionFor(partition),
  },
}));

vi.mock('@core/features/browser/node', () => ({
  browserEvents: { emit: vi.fn() },
  hasBrowserEventSubscribers: vi.fn(() => false),
}));

vi.mock('@core/features/workbench/node', () => ({
  desktopHostEvents: { emit: vi.fn() },
}));

vi.mock('./automation/page-automation', () => ({
  createPageAutomation: vi.fn(),
}));

function sessionFor(partition: string): object {
  let value = sessionsByPartition.get(partition);
  if (!value) {
    value = { partition, getUserAgent: () => 'base-ua' };
    sessionsByPartition.set(partition, value);
  }
  return value;
}

type FakeWebContents = WebContents & { destroy(): void };

let nextWebContentsId = 1;

function fakeWebContents(): FakeWebContents {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  let destroyed = false;
  const fake = {
    id: nextWebContentsId++,
    session: sessionFor(PROFILE_PARTITION),
    isDestroyed: () => destroyed,
    getURL: () => 'https://example.com/',
    getTitle: () => 'Example',
    getUserAgent: () => 'base-ua',
    setUserAgent: vi.fn(),
    setWindowOpenHandler: vi.fn(),
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
  };
  return fake as unknown as FakeWebContents;
}

function fakeAutomation(): MainPageAutomation {
  return { dispose: vi.fn(), startNetworkCapture: vi.fn() } as unknown as MainPageAutomation;
}

const TASK = { projectId: 'project-1', workspaceId: 'workspace-1', taskId: 'task-1' };

function setup() {
  const events: BrowserEvent[] = [];
  const registry = new BrowserWebContentsRegistry({
    emit: (event) => events.push(event),
    hasRenderer: () => true,
  });
  const port = createAgentBrowserPort({
    registry,
    createPageAutomation: vi.mocked(createPageAutomation),
  });

  const openLive = (browserId: string): FakeWebContents => {
    registry.registerSession({ browserId, partition: PROFILE_PARTITION, ...TASK });
    const webContents = fakeWebContents();
    registry.handleWebviewAttached(webContents);
    registry.bindWebContents(browserId, webContents);
    return webContents;
  };

  return { events, registry, port, openLive };
}

describe('createAgentBrowserPort', () => {
  beforeEach(() => {
    sessionsByPartition.clear();
    vi.mocked(createPageAutomation).mockReset();
    vi.mocked(createPageAutomation).mockImplementation(() => fakeAutomation());
  });

  it('lists and reads tabs from the registry', () => {
    const { port, openLive } = setup();
    openLive('browser-1');

    expect(port.listTabs({ projectId: 'project-1', taskId: 'task-1' })).toEqual([
      expect.objectContaining({ browserId: 'browser-1', live: true }),
    ]);
    expect(port.getTab('browser-1')).toMatchObject({ url: 'https://example.com/' });
    expect(port.getTab('missing')).toBeNull();
  });

  it('returns null pages for unknown or not live tabs', () => {
    const { registry, port } = setup();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION, ...TASK });

    expect(port.page('missing')).toBeNull();
    expect(port.page('browser-1')).toBeNull();
    expect(createPageAutomation).not.toHaveBeenCalled();
  });

  it('caches one page automation per WebContents and marks agent activity', () => {
    const { events, port, openLive } = setup();
    const webContents = openLive('browser-1');

    const first = port.page('browser-1');
    const second = port.page('browser-1');

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(createPageAutomation).toHaveBeenCalledTimes(1);
    expect(createPageAutomation).toHaveBeenCalledWith(webContents);
    // Ağ kaydı ajan sekmeyi kullanınca başlar.
    expect(
      vi.mocked(createPageAutomation).mock.results[0]?.value.startNetworkCapture
    ).toHaveBeenCalled();
    expect(events).toContainEqual({
      type: 'agent-activity',
      browserId: 'browser-1',
      at: expect.any(Number),
    });
  });

  it('serves UI pages without marking agent activity or starting network capture', () => {
    const { events, port, openLive } = setup();
    openLive('browser-1');

    expect(port.userPage('browser-1', { create: false })).toBeNull();
    const page = port.userPage('browser-1');

    expect(page).not.toBeNull();
    expect(page?.startNetworkCapture).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'agent-activity')).toBe(false);
    expect(port.userPage('browser-1', { create: false })).toBe(page);
    // Aynı sayfayı ajan kullanınca aynı kontrolcü döner ve ağ kaydı başlar.
    expect(port.page('browser-1')).toBe(page);
    expect(page?.startNetworkCapture).toHaveBeenCalledTimes(1);
  });

  it('disposes the automation when the page is destroyed and recreates it for a new page', () => {
    const { registry, port, openLive } = setup();
    const webContents = openLive('browser-1');
    const first = port.page('browser-1')!;

    webContents.destroy();

    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(port.page('browser-1')).toBeNull();

    const next = fakeWebContents();
    registry.handleWebviewAttached(next);
    registry.bindWebContents('browser-1', next);
    const second = port.page('browser-1');

    expect(second).not.toBe(first);
    expect(createPageAutomation).toHaveBeenLastCalledWith(next);
  });

  it('disposes the automation when the session is unregistered', () => {
    const { registry, port, openLive } = setup();
    openLive('browser-1');
    const page = port.page('browser-1')!;

    registry.unregisterSession('browser-1');

    expect(page.dispose).toHaveBeenCalledTimes(1);
    expect(port.page('browser-1')).toBeNull();
  });

  it('opens tabs through the registry and marks them as agent driven', async () => {
    const { events, registry, port } = setup();

    const opened = port.openTab({ ...TASK, url: 'https://example.com/' });
    const request = events.find((event) => event.type === 'open-requested');
    if (!request || request.type !== 'open-requested') throw new Error('No open request');
    registry.resolveAgentRequest({ requestId: request.requestId, ok: true, browserId: 'new' });
    registry.registerSession({ browserId: 'new', partition: PROFILE_PARTITION, ...TASK });
    const webContents = fakeWebContents();
    registry.handleWebviewAttached(webContents);
    registry.bindWebContents('new', webContents);

    await expect(opened).resolves.toMatchObject({ browserId: 'new', live: true });
    expect(events).toContainEqual({
      type: 'agent-activity',
      browserId: 'new',
      at: expect.any(Number),
    });
  });

  it('activates and closes tabs through the registry and drops the closed page', async () => {
    const { events, registry, port, openLive } = setup();
    openLive('browser-1');
    const page = port.page('browser-1')!;

    const activated = port.activateTab('browser-1');
    registry.resolveAgentRequest({ requestId: lastRequestId(events), ok: true });
    await expect(activated).resolves.toBeUndefined();
    expect(port.getTab('browser-1')?.active).toBe(true);

    const closed = port.closeTab('browser-1');
    registry.resolveAgentRequest({ requestId: lastRequestId(events), ok: true });
    await expect(closed).resolves.toBeUndefined();

    expect(page.dispose).toHaveBeenCalledTimes(1);
    expect(port.getTab('browser-1')).toBeNull();
  });

  it('releases every cached automation on dispose', () => {
    const { port, openLive } = setup();
    openLive('browser-1');
    openLive('browser-2');
    const pages = [port.page('browser-1')!, port.page('browser-2')!];

    port.dispose();

    for (const page of pages) expect(page.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('agentBrowserPort', () => {
  it('is wired to the app registry and rejects requests while no window listens', async () => {
    expect(agentBrowserPort.getTab('missing')).toBeNull();
    expect(agentBrowserPort.page('missing')).toBeNull();
    await expect(agentBrowserPort.openTab(TASK)).rejects.toThrow(/window is not open/);
  });
});

function lastRequestId(events: BrowserEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && 'requestId' in event) return event.requestId;
  }
  throw new Error('No agent request was emitted');
}
