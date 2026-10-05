import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserAgentActivity } from '@core/features/browser/api/browser/browser-agent-activity';
import { browserControlsRegistry } from '@core/features/browser/api/browser/browser-controls-registry';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { browserWebviewHost } from '@core/features/browser/api/browser/browser-webview-host';
import { BrowserPane } from './browser-pane';
import { BrowserWebviewLayer } from './browser-webview-layer';

const browserRpc = vi.hoisted(() => ({
  bindWebContents: vi.fn(),
  registerSession: vi.fn(),
  setActiveBrowser: vi.fn(),
}));

const toolbarProps = vi.hoisted(() => ({ autoFocusUrl: undefined as boolean | undefined }));

vi.mock('@core/features/workbench/api/browser/task-composition-context', () => ({
  usePreviewServers: () => ({ urls: [] }),
}));

vi.mock('@core/primitives/workbench-shell/browser/tabs/pane-context', () => ({
  usePaneContext: () => ({
    paneId: 'pane-1',
    pane: { setNextTabActive: vi.fn(), setPreviousTabActive: vi.fn() },
    scopeInstance: { id: 'view-scope-7', getCommand: vi.fn() },
  }),
}));

vi.mock('@core/features/browser/api/browser/client', () => ({
  getBrowserClient: async () => browserRpc,
}));

vi.mock('@core/primitives/desktop-host/browser/host-client', () => ({
  getHostClient: async () => ({
    events: {
      subscribe: vi.fn(async () => () => {}),
    },
  }),
}));

vi.mock('./browser-toolbar', async () => {
  const React = await import('react');
  return {
    BrowserToolbar: ({
      onNavigate,
      autoFocusUrl,
    }: {
      onNavigate?: (url: string) => boolean;
      autoFocusUrl?: boolean;
    }) => {
      toolbarProps.autoFocusUrl = autoFocusUrl;
      return React.createElement('button', {
        onClick: () => onNavigate?.('https://linkedin.com/'),
      });
    },
  };
});

class NoopResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

describe('BrowserPane with the persistent webview layer', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = dom.window.document.getElementById('root')!;
    root = createRoot(container);
    browserSessionStore.clear();
    browserControlsRegistry.clear();
    browserAgentActivity.clear();
    browserRpc.registerSession.mockResolvedValue({ success: true });
    browserRpc.bindWebContents.mockResolvedValue({ success: true });
    toolbarProps.autoFocusUrl = undefined;
  });

  afterEach(() => {
    act(() => root.unmount());
    for (const browserId of browserSessionStore.sessions.keys()) {
      browserWebviewHost.forget(browserId);
    }
    browserSessionStore.clear();
    browserControlsRegistry.clear();
    browserAgentActivity.clear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    dom.window.close();
  });

  function createSession(initialUrl?: string) {
    return browserSessionStore.createSession({
      browserId: 'browser-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      initialUrl,
    });
  }

  async function render(panes: Array<{ visible: boolean }>, browserId = 'browser-1') {
    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          // Tab bodies come and go with the task view; the layer is a stable sibling.
          React.createElement(
            'div',
            { 'data-task-view': '' },
            panes.map((pane, index) =>
              React.createElement(BrowserPane, { key: index, browserId, visible: pane.visible })
            )
          ),
          React.createElement(BrowserWebviewLayer)
        )
      );
    });
  }

  function host(browserId = 'browser-1'): HTMLElement {
    return container.querySelector<HTMLElement>(`[data-browser-webview-host="${browserId}"]`)!;
  }

  function fakeWebview(webview: HTMLElement, overrides: Record<string, unknown> = {}) {
    Object.assign(webview, {
      canGoBack: () => false,
      canGoForward: () => false,
      getTitle: () => 'Page',
      getURL: () => webview.getAttribute('src'),
      getWebContentsId: () => 123,
      setZoomFactor: vi.fn(),
      focus: vi.fn(),
      ...overrides,
    });
  }

  it('registers the session with its task identity before mounting the page', async () => {
    createSession('http://localhost:3000/');
    await render([{ visible: true }]);

    expect(browserRpc.registerSession).toHaveBeenCalledWith({
      browserId: 'browser-1',
      partition: 'persist:orkestra-browser-profile',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      url: 'http://localhost:3000/',
      title: '',
    });
    expect(container.querySelector('webview')?.getAttribute('src')).toBe('http://localhost:3000/');
    expect(container.querySelector('[data-browser-webview-placeholder] webview')).toBeNull();
  });

  it('does not load the submitted URL twice when the webview becomes ready', async () => {
    const session = createSession();
    await render([{ visible: true }]);
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const webview = container.querySelector<HTMLElement>('webview')!;
    const loadURL = vi.fn();
    fakeWebview(webview, { loadURL });

    await act(async () => webview.dispatchEvent(new dom.window.Event('dom-ready')));

    expect(webview.getAttribute('src')).toBe('https://linkedin.com/');
    expect(loadURL).not.toHaveBeenCalled();
    expect(browserRpc.bindWebContents).toHaveBeenCalledWith({
      browserId: session.browserId,
      webContentsId: 123,
    });
  });

  it('loads later navigations through the ready webview', async () => {
    createSession('https://example.com/');
    await render([{ visible: true }]);
    const webview = container.querySelector<HTMLElement>('webview')!;
    const loadURL = vi.fn(async () => {});
    fakeWebview(webview, { loadURL });
    await act(async () => webview.dispatchEvent(new dom.window.Event('dom-ready')));

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(loadURL).toHaveBeenCalledWith('https://linkedin.com/');
    expect(container.querySelector('webview')).toBe(webview);
  });

  it('binds the page as soon as the guest attaches', async () => {
    createSession('https://example.com/');
    await render([{ visible: true }]);
    const webview = container.querySelector<HTMLElement>('webview')!;
    fakeWebview(webview, { getWebContentsId: () => 77 });

    await act(async () => webview.dispatchEvent(new dom.window.Event('did-attach')));

    expect(browserRpc.bindWebContents).toHaveBeenCalledWith({
      browserId: 'browser-1',
      webContentsId: 77,
    });
  });

  it('keeps the healthy page mounted when an iframe fails to load', async () => {
    const session = createSession('http://localhost:3000/');
    await render([{ visible: true }]);

    const webview = container.querySelector<HTMLElement>('webview')!;
    fakeWebview(webview, {
      getTitle: () => 'Healthy parent',
      getURL: () => 'http://localhost:3000/',
    });

    await act(async () => {
      webview.dispatchEvent(new Event('dom-ready'));
      webview.dispatchEvent(new Event('did-start-loading'));
      webview.dispatchEvent(
        Object.assign(new Event('did-navigate'), { url: 'http://localhost:3000/' })
      );
    });
    await act(async () => {
      webview.dispatchEvent(
        Object.assign(new Event('did-fail-load'), {
          errorCode: -102,
          errorDescription: 'ERR_CONNECTION_REFUSED',
          validatedURL: 'http://localhost:3001/missing-frame',
          isMainFrame: false,
        })
      );
    });

    expect(container.querySelector('webview')).toBe(webview);

    await act(async () => webview.dispatchEvent(new Event('did-stop-loading')));

    expect(container.querySelector('webview')).toBe(webview);
    expect(container.querySelector('h1')).toBeNull();
    expect(browserSessionStore.getSession(session.browserId)).toMatchObject({
      currentUrl: 'http://localhost:3000/',
      title: 'Healthy parent',
      isLoading: false,
      loadError: undefined,
    });
  });

  it('keeps the page mounted but hidden behind a main frame load error', async () => {
    createSession('https://missing.invalid/');
    await render([{ visible: true }]);
    const webview = container.querySelector<HTMLElement>('webview')!;
    fakeWebview(webview);
    expect(host().style.visibility).toBe('visible');

    await act(async () => {
      webview.dispatchEvent(new Event('dom-ready'));
      webview.dispatchEvent(
        Object.assign(new Event('did-fail-load'), {
          errorCode: -105,
          errorDescription: 'net::ERR_NAME_NOT_RESOLVED',
          validatedURL: 'https://missing.invalid/',
          isMainFrame: true,
        })
      );
    });

    expect(container.querySelector('h1')?.textContent).toBe("This site can't be reached");
    expect(container.querySelector('webview')).toBe(webview);
    expect(host().style.visibility).toBe('hidden');
  });

  it('renders a minimal load error state', async () => {
    const session = createSession('https://missing.invalid/');
    browserSessionStore.updateSession(session.browserId, {
      isLoading: false,
      loadError: {
        code: -105,
        description: 'net::ERR_NAME_NOT_RESOLVED',
        url: 'https://missing.invalid/',
      },
    });

    await render([{ visible: true }]);

    expect(container.querySelector('h1')?.textContent).toBe("This site can't be reached");
    expect(container.querySelector('p')?.textContent).toBe(
      "missing.invalid's server IP address could not be found. (ERR_NAME_NOT_RESOLVED)"
    );
    expect(container.textContent).not.toContain('Try:');
    expect(
      Array.from(container.querySelectorAll('button'))
        .map((button) => button.textContent)
        .filter(Boolean)
    ).toEqual(['Reload', 'Open externally']);
  });

  it('shows the page only while its tab is visible and keeps it alive when the tab unmounts', async () => {
    createSession('https://example.com/');
    await render([{ visible: true }]);
    const webview = container.querySelector<HTMLElement>('webview')!;
    expect(host().style.visibility).toBe('visible');
    expect(host().inert).toBe(false);
    expect(host().getAttribute('data-view-scope')).toBe('view-scope-7');

    await render([{ visible: false }]);
    expect(host().style.visibility).toBe('hidden');
    expect(host().inert).toBe(true);
    expect(host().style.pointerEvents).toBe('none');
    expect(host().hasAttribute('data-view-scope')).toBe(false);

    // Switching to another task unmounts the tab content, not the page.
    await render([]);
    expect(container.querySelector('webview')).toBe(webview);
    expect(host().style.visibility).toBe('hidden');

    await render([{ visible: true }]);
    expect(container.querySelector('webview')).toBe(webview);
    expect(host().style.visibility).toBe('visible');
  });

  it('mounts a single webview per browser even when two tab bodies render it', async () => {
    createSession('https://example.com/');
    await render([{ visible: true }, { visible: true }]);

    expect(container.querySelectorAll('webview')).toHaveLength(1);
    expect(container.querySelectorAll('[data-browser-webview-placeholder]')).toHaveLength(2);
  });

  it('destroys the page when its session closes', async () => {
    createSession('https://example.com/');
    await render([{ visible: true }]);
    expect(container.querySelector('webview')).not.toBeNull();

    await act(async () => browserSessionStore.removeSession('browser-1'));

    expect(container.querySelector('webview')).toBeNull();
    expect(container.querySelector('[data-browser-webview-host]')).toBeNull();
  });

  it('does not steal focus for blank tabs an agent opened', async () => {
    createSession();
    await render([{ visible: true }]);
    expect(toolbarProps.autoFocusUrl).toBe(true);

    await act(async () => browserAgentActivity.markAgentOpened('browser-1'));
    expect(toolbarProps.autoFocusUrl).toBe(false);
  });

  it('forwards focus from the placeholder into the page', async () => {
    createSession('https://example.com/');
    await render([{ visible: true }]);
    const webview = container.querySelector<HTMLElement>('webview')!;
    const focus = vi.fn();
    fakeWebview(webview, { focus });
    await act(async () => webview.dispatchEvent(new Event('dom-ready')));

    const placeholder = container.querySelector<HTMLElement>('[data-pane-focus-proxy]')!;
    await act(async () => placeholder.focus());

    expect(focus).toHaveBeenCalled();
  });
});
