import { act, useRef, type CSSProperties } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import {
  browserWebviewHost,
  type BrowserDropHighlight,
} from '@core/features/browser/api/browser/browser-webview-host';
import { BrowserWebviewLayer } from './browser-webview-layer';
import { useBrowserWebviewSlot } from './browser-webview-slot';

const browserRpc = vi.hoisted(() => ({
  bindWebContents: vi.fn(async () => ({ success: true })),
  registerSession: vi.fn(async () => ({ success: true })),
}));

vi.mock('@core/features/browser/api/browser/client', () => ({
  getBrowserClient: async () => browserRpc,
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

const TOOLBAR_HEIGHT = 40;

/** Tab body stand-in: a toolbar strip and the page placeholder below it (as BrowserPane). */
function TestTab({
  frame,
  show = true,
  highlight = null,
  interactive = true,
}: {
  frame: CSSProperties;
  show?: boolean;
  highlight?: BrowserDropHighlight | null;
  interactive?: boolean;
}) {
  const regionRef = useRef<HTMLDivElement | null>(null);
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  useBrowserWebviewSlot({
    browserId: 'browser-1',
    placeholderRef,
    regionRef,
    show,
    interactive,
    scopeId: 'view-scope-1',
    highlight,
  });
  return (
    <div ref={regionRef} data-frame="" style={{ position: 'absolute', ...frame }}>
      <div style={{ height: TOOLBAR_HEIGHT }} />
      <div
        ref={placeholderRef}
        data-placeholder=""
        style={{ position: 'absolute', top: TOOLBAR_HEIGHT, left: 0, right: 0, bottom: 0 }}
      />
    </div>
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function rectOf(element: Element) {
  const rect = element.getBoundingClientRect();
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

describe('BrowserWebviewLayer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    browserSessionStore.clear();
    browserSessionStore.createSession({
      browserId: 'browser-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      initialUrl: 'https://example.com/',
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    browserWebviewHost.forget('browser-1');
    browserSessionStore.clear();
    container.remove();
  });

  async function render(tab: Parameters<typeof TestTab>[0] | null) {
    await act(async () => {
      root.render(
        <>
          <div data-task-view="">{tab ? <TestTab {...tab} /> : null}</div>
          <BrowserWebviewLayer />
        </>
      );
    });
    await act(async () => {
      await nextFrame();
    });
  }

  function host() {
    return container.querySelector<HTMLElement>('[data-browser-webview-host="browser-1"]')!;
  }

  it('positions the page over the visible tab placeholder', async () => {
    await render({ frame: { left: 120, top: 60, width: 480, height: 320 } });

    const placeholder = container.querySelector('[data-placeholder]')!;
    expect(rectOf(placeholder)).toEqual({ left: 120, top: 100, width: 480, height: 280 });
    expect(rectOf(host())).toEqual(rectOf(placeholder));
    expect(getComputedStyle(host()).visibility).toBe('visible');
    expect(getComputedStyle(host()).pointerEvents).toBe('auto');
    expect(host().getAttribute('data-view-scope')).toBe('view-scope-1');
    const webview = host().querySelector('webview')!;
    expect(webview.getAttribute('src')).toBe('https://example.com/');
    expect(rectOf(webview)).toEqual(rectOf(placeholder));
  });

  it('follows the placeholder when it resizes and when it only moves', async () => {
    await render({ frame: { left: 120, top: 60, width: 480, height: 320 } });
    const frame = container.querySelector<HTMLElement>('[data-frame]')!;

    frame.style.width = '640px';
    await act(async () => {
      await nextFrame();
      await nextFrame();
    });
    expect(rectOf(host())).toEqual({ left: 120, top: 100, width: 640, height: 280 });

    // A pure move does not resize the placeholder; the fallback poll picks it up.
    frame.style.left = '200px';
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(rectOf(host())).toEqual({ left: 200, top: 100, width: 640, height: 280 });
  });

  it('keeps the same page alive and hidden, at its last size, while the tab is not rendered', async () => {
    await render({ frame: { left: 0, top: 0, width: 400, height: 300 } });
    const webview = host().querySelector('webview');
    expect(webview).not.toBeNull();

    // Switching tasks unmounts the tab body; the page must survive.
    await render(null);
    expect(host().querySelector('webview')).toBe(webview);
    expect(webview?.isConnected).toBe(true);
    expect(getComputedStyle(host()).visibility).toBe('hidden');
    expect(getComputedStyle(host()).display).not.toBe('none');
    expect(host().inert).toBe(true);
    expect(host().hasAttribute('data-view-scope')).toBe(false);
    expect(rectOf(host())).toEqual({ left: 0, top: 40, width: 400, height: 260 });

    await render({ frame: { left: 10, top: 10, width: 500, height: 300 } });
    expect(host().querySelector('webview')).toBe(webview);
    expect(getComputedStyle(host()).visibility).toBe('visible');
    expect(rectOf(host())).toEqual({ left: 10, top: 50, width: 500, height: 260 });
  });

  it('hides the page while its tab shows something else', async () => {
    await render({ frame: { left: 0, top: 0, width: 400, height: 300 } });
    await render({ frame: { left: 0, top: 0, width: 400, height: 300 }, show: false });

    expect(getComputedStyle(host()).visibility).toBe('hidden');
    expect(host().querySelector('webview')).not.toBeNull();
  });

  it('lets drags pass through and draws the pane drop highlight above the page', async () => {
    await render({
      frame: { left: 100, top: 100, width: 400, height: 300 },
      interactive: false,
      highlight: 'bottom',
    });

    expect(getComputedStyle(host()).pointerEvents).toBe('none');
    const overlay = host().querySelector('[data-browser-drop-highlight="bottom"]')!;
    // Bottom half of the whole tab region (toolbar included), clipped to the page area.
    expect(rectOf(overlay)).toEqual({ left: 100, top: 250, width: 400, height: 150 });

    await render({
      frame: { left: 100, top: 100, width: 400, height: 300 },
      interactive: false,
      highlight: 'left',
    });
    expect(rectOf(host().querySelector('[data-browser-drop-highlight="left"]')!)).toEqual({
      left: 100,
      top: 100,
      width: 200,
      height: 300,
    });

    await render({ frame: { left: 100, top: 100, width: 400, height: 300 } });
    expect(host().querySelector('[data-browser-drop-highlight]')).toBeNull();
    expect(getComputedStyle(host()).pointerEvents).toBe('auto');
  });

  it('removes the page when its session closes', async () => {
    await render({ frame: { left: 0, top: 0, width: 400, height: 300 } });
    expect(host().querySelector('webview')).not.toBeNull();

    await act(async () => browserSessionStore.removeSession('browser-1'));

    expect(container.querySelector('webview')).toBeNull();
  });
});
