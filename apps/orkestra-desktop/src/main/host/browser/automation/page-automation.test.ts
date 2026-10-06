import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeHost, FakeWebContents, pageOk } from './fake-web-contents.test-support';
import { createPageAutomation } from './page-automation';
import type { PageCommand, PageResult } from './page-script';
import { HIDDEN_TAB_SCREENSHOT_ERROR } from './screenshot';
import { isAutomationInputActive } from './synthetic-input';

const SNAPSHOT_VALUE = {
  url: 'https://start.test/',
  title: 'Start',
  outline: '- button "Go" [ref=e1]',
  truncated: false,
  nextRef: 2,
};

function setup(options: { platform?: NodeJS.Platform } = {}) {
  const wc = new FakeWebContents();
  const handlers: Partial<Record<PageCommand['kind'], (command: PageCommand) => PageResult>> = {
    snapshot: () => pageOk(SNAPSHOT_VALUE),
    locate: () => pageOk({ point: { x: 100, y: 50 }, label: 'e1' }),
    scrollProbe: () =>
      pageOk({
        point: { x: 400, y: 300 },
        position: { x: 0, y: 0, windowX: 0, windowY: 0 },
        defaultAmount: 480,
      }),
    scrollRead: () => pageOk({ position: { x: 0, y: 0, windowX: 0, windowY: 0 } }),
    scrollBy: () => pageOk({ position: { x: 0, y: 480, windowX: 0, windowY: 480 } }),
    metrics: () =>
      pageOk({
        viewportWidth: 800,
        viewportHeight: 600,
        scrollX: 0,
        scrollY: 0,
        contentWidth: 800,
        contentHeight: 600,
        devicePixelRatio: 2,
      }),
  };
  wc.pageHandler = (command) => {
    const handler = handlers[command.kind];
    return handler ? handler(command) : { ok: false, error: `unhandled ${command.kind}` };
  };
  wc.onLoadURL = async (url) => wc.emitMainFrameNavigation(url);
  const page = createPageAutomation(wc.asWebContents(), {
    platform: options.platform ?? 'linux',
    preserveEmbedderFocus: true,
  });
  return { wc, page, handlers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('navigation', () => {
  it('validates schemes before loading and resolves with the settled page info', async () => {
    const { wc, page } = setup();
    await expect(page.navigate('javascript:alert(1)')).rejects.toThrow(/Unsupported URL scheme/);
    expect(wc.loadedUrls).toEqual([]);
    wc.onLoadURL = async (url) => {
      wc.emitMainFrameNavigation(url);
      wc.title = 'Local';
    };
    await expect(page.navigate('localhost:5173')).resolves.toEqual({
      url: 'http://localhost:5173/',
      title: 'Local',
    });
  });

  it('reports failed loads and never hangs on them', async () => {
    const { wc, page } = setup();
    wc.onLoadURL = async (url) => {
      wc.emit(
        'did-start-navigation',
        { isMainFrame: true, isSameDocument: false },
        url,
        false,
        true
      );
      wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', url, true);
      throw Object.assign(new Error('ERR_NAME_NOT_RESOLVED (-105)'), {
        errno: -105,
        code: 'ERR_NAME_NOT_RESOLVED',
      });
    };
    await expect(page.navigate('https://nope.invalid/')).rejects.toThrow(
      'Navigation to https://nope.invalid/ failed: ERR_NAME_NOT_RESOLVED (-105).'
    );
  });

  it('ignores ERR_ABORTED caused by a client-side redirect and returns the final page', async () => {
    const { wc, page } = setup();
    wc.onLoadURL = async (url) => {
      wc.emit(
        'did-start-navigation',
        { isMainFrame: true, isSameDocument: false },
        url,
        false,
        true
      );
      wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', url, true);
      wc.emitMainFrameNavigation('https://final.test/');
      throw Object.assign(new Error('ERR_ABORTED (-3)'), { errno: -3, code: 'ERR_ABORTED' });
    };
    await expect(page.navigate('https://redirect.test/')).resolves.toMatchObject({
      url: 'https://final.test/',
    });
  });

  it('times out with a message that names the URL', async () => {
    vi.useFakeTimers();
    const { wc, page } = setup();
    wc.onLoadURL = async (url) => {
      wc.emit(
        'did-start-navigation',
        { isMainFrame: true, isSameDocument: false },
        url,
        false,
        true
      );
      await new Promise(() => undefined);
    };
    const result = page.navigate('https://slow.test/', { timeoutMs: 2_000 });
    const assertion = expect(result).rejects.toThrow(
      /Timed out after 2000 ms waiting for https:\/\/slow\.test\//
    );
    await vi.advanceTimersByTimeAsync(2_100);
    await assertion;
  });

  it('refuses to go back without history and follows history otherwise', async () => {
    const { wc, page } = setup();
    await expect(page.goBack()).rejects.toThrow(/Cannot go back/);
    wc.canGoBack = true;
    await expect(page.goBack()).resolves.toMatchObject({ url: 'https://start.test/back' });
    await expect(page.reload()).resolves.toMatchObject({ url: 'https://start.test/back' });
    expect(wc.reloadCalls).toBe(1);
  });
});

describe('snapshot and refs', () => {
  it('requires a snapshot before refs and invalidates refs on navigation', async () => {
    const { wc, page } = setup();
    await expect(page.click({ ref: 'e1' })).rejects.toThrow(
      'Element ref e1 not found; take a new snapshot.'
    );
    await expect(page.snapshot()).resolves.toEqual({
      url: SNAPSHOT_VALUE.url,
      title: SNAPSHOT_VALUE.title,
      outline: SNAPSHOT_VALUE.outline,
      truncated: false,
    });
    expect(wc.pageCommands.at(-1)).toMatchObject({
      kind: 'snapshot',
      resetRefs: true,
      refStart: 1,
      maxChars: 12_000,
    });

    // Yalnızca durum değiştiren replaceState (aynı URL) referansları bozmaz.
    wc.emit('did-navigate-in-page', {}, 'https://start.test/', true);
    await expect(page.hover({ ref: 'e1' })).resolves.toBeUndefined();

    wc.emit('did-navigate-in-page', {}, 'https://start.test/#other', true);
    await expect(page.hover({ ref: 'e1' })).rejects.toThrow(
      'Element ref e1 not found; take a new snapshot.'
    );

    await page.snapshot({ maxChars: 3_000 });
    expect(wc.pageCommands.at(-1)).toMatchObject({
      kind: 'snapshot',
      resetRefs: true,
      refStart: 2,
      maxChars: 3_000,
    });
    await page.snapshot();
    expect(wc.pageCommands.at(-1)).toMatchObject({ resetRefs: false });

    wc.emitMainFrameNavigation('https://other.test/');
    await expect(page.click({ ref: 'e1' })).rejects.toThrow(/take a new snapshot/);
  });

  it('passes page-side errors through unchanged', async () => {
    const { page, handlers } = setup();
    handlers.locate = () => ({
      ok: false,
      error: 'Element ref e9 not found; take a new snapshot.',
    });
    await page.snapshot();
    await expect(page.click({ ref: 'e9' })).rejects.toThrow(
      'Element ref e9 not found; take a new snapshot.'
    );
  });
});

describe('trusted input', () => {
  it('clicks at the zoom-corrected point with marked automation input and focus emulation', async () => {
    const { wc, page } = setup();
    wc.zoom = 1.5;
    await page.snapshot();
    await page.click({ ref: 'e1' }, { button: 'right', clickCount: 1, modifiers: ['shift'] });
    expect(wc.inputEvents).toEqual([
      { type: 'mouseMove', x: 150, y: 75, modifiers: ['shift'] },
      { type: 'mouseDown', x: 150, y: 75, button: 'right', clickCount: 1, modifiers: ['shift'] },
      { type: 'mouseUp', x: 150, y: 75, button: 'right', clickCount: 1, modifiers: ['shift'] },
    ]);
    expect(wc.inputMarkedAsAutomation).toEqual([true, true, true]);
    // Sağ tık sonrası bağlam menüsü olayları için işaret bir süre açık kalır.
    expect(isAutomationInputActive(wc.asWebContents())).toBe(true);
    expect(wc.debugger.commands).toContainEqual({
      method: 'Emulation.setFocusEmulationEnabled',
      params: { enabled: true },
    });
  });

  it('restores the embedder focus around trusted clicks', async () => {
    const { wc, page } = setup();
    const host = createFakeHost();
    wc.hostWebContents = host;
    await page.click({ x: 10, y: 20 });
    expect(host.scripts).toHaveLength(2);
    expect(host.scripts[0]).toContain('__orkestraEmbedderFocus = {');
    expect(host.scripts[1]).toContain('const memo');
  });

  it('validates click options and targets', async () => {
    const { page } = setup();
    await expect(page.click({ x: 1, y: 1 }, { button: 'side' as 'left' })).rejects.toThrow(
      /Invalid mouse button/
    );
    await expect(page.click({ x: 1, y: 1 }, { modifiers: ['hyper' as 'meta'] })).rejects.toThrow(
      /Invalid modifier/
    );
    await expect(page.click({} as { ref: string })).rejects.toThrow(/Invalid target/);
  });

  it('types with clear and submit using select-all, Backspace, insertText and Enter', async () => {
    const { wc, page, handlers } = setup();
    let empty = false;
    handlers.prepareType = () =>
      pageOk({ focused: true, point: null, occlusion: null, mode: 'text', label: 'e1' });
    handlers.editState = () =>
      pageOk({ kind: 'input', label: '<input>', empty, allSelected: true });
    wc.sendInputEvent = function (event) {
      FakeWebContents.prototype.sendInputEvent.call(this, event);
      if (event.type === 'keyDown' && 'keyCode' in event && event.keyCode === 'Backspace')
        empty = true;
    };
    await page.snapshot();
    await page.type({ ref: 'e1' }, 'hello', { clear: true, submit: true });
    const keys = wc.inputEvents.map(
      (event) => `${event.type}:${'keyCode' in event ? event.keyCode : ''}`
    );
    expect(keys).toEqual([
      'keyDown:Control',
      'keyDown:a',
      'keyUp:a',
      'keyUp:Control',
      'keyDown:Backspace',
      'keyUp:Backspace',
      'keyDown:Enter',
      'char:\r',
      'keyUp:Enter',
    ]);
    expect(wc.insertedText).toEqual(['hello']);
  });

  it('falls back to the native select-all command and a forced clear when keys do not work', async () => {
    const { wc, page, handlers } = setup({ platform: 'darwin' });
    handlers.editState = () =>
      pageOk({ kind: 'textarea', label: '<textarea>', empty: false, allSelected: false });
    handlers.forceClear = () => pageOk({ empty: true });
    await page.type(null, 'x', { clear: true });
    expect(wc.selectAllCalls).toBe(1);
    expect(wc.pageCommands.some((command) => command.kind === 'forceClear')).toBe(true);
    expect(wc.insertedText).toEqual(['x']);
  });

  it('refuses to type when nothing editable is focused and uses direct values for date inputs', async () => {
    const { wc, page, handlers } = setup();
    handlers.editState = () =>
      pageOk({ kind: 'other', label: '<button>', empty: false, allSelected: false });
    await expect(page.type(null, 'x')).rejects.toThrow(/focused element <button> is not editable/);
    handlers.prepareType = () =>
      pageOk({ focused: false, point: null, occlusion: null, mode: 'value', label: 'e1' });
    handlers.setValue = (command) => pageOk({ value: 'value' in command ? command.value : '' });
    await page.snapshot();
    await page.type({ ref: 'e1' }, '2024-05-17');
    expect(wc.pageCommands.at(-1)).toMatchObject({ kind: 'setValue', value: '2024-05-17' });
    expect(wc.insertedText).toEqual([]);
  });

  it('blocks clipboard paste chords and emulates Meta+A on macOS unless the page handled it', async () => {
    const { wc, page, handlers } = setup({ platform: 'darwin' });
    await expect(page.pressKey('Meta+V')).rejects.toThrow(
      /Pasting from the system clipboard is not allowed/
    );
    handlers.watchKey = () => pageOk({ watching: true });
    handlers.keyResult = () => pageOk({ seen: true, defaultPrevented: false });
    await page.pressKey('Meta+A');
    expect(wc.selectAllCalls).toBe(1);
    handlers.keyResult = () => pageOk({ seen: true, defaultPrevented: true });
    await page.pressKey('Meta+A');
    expect(wc.selectAllCalls).toBe(1);
  });

  it('scrolls with a zoom-scaled precise wheel and falls back to scrollBy when nothing moved', async () => {
    const { wc, page } = setup();
    wc.zoom = 2;
    await page.scroll({ direction: 'down' });
    expect(wc.inputEvents).toEqual([
      {
        type: 'mouseWheel',
        x: 800,
        y: 600,
        deltaX: 0,
        deltaY: -960,
        hasPreciseScrollingDeltas: true,
      },
    ]);
    expect(wc.pageCommands.at(-1)).toEqual({ kind: 'scrollBy', direction: 'down', amount: 480 });
    await expect(page.scroll({ amount: -5 })).rejects.toThrow(/positive number/);
  });

  it('does not top up a wheel scroll that moved the full amount', async () => {
    const { wc, page, handlers } = setup();
    handlers.scrollRead = () => pageOk({ position: { x: 0, y: 200, windowX: 0, windowY: 200 } });
    await page.scroll({ direction: 'down', amount: 200 });
    expect(wc.pageCommands.some((command) => command.kind === 'scrollBy')).toBe(false);
  });

  it('serializes concurrent operations', async () => {
    const { wc, page, handlers } = setup();
    const order: string[] = [];
    let release: () => void = () => undefined;
    handlers.text = () => {
      order.push('text');
      return pageOk({ text: 'hi', truncated: false });
    };
    const slowSnapshot = new Promise<PageResult>((resolve) => {
      release = () => resolve(pageOk(SNAPSHOT_VALUE));
    });
    wc.pageHandler = (command) => {
      if (command.kind === 'snapshot') {
        order.push('snapshot');
        return slowSnapshot;
      }
      const handler = handlers[command.kind];
      return handler ? handler(command) : { ok: false, error: 'unhandled' };
    };
    const first = page.snapshot();
    const second = page.getText();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['snapshot']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['snapshot', 'text']);
  });
});

describe('reading the page', () => {
  it('buffers console messages from Electron 40 console-message events', () => {
    const { wc, page } = setup();
    wc.emit('console-message', {
      level: 'error',
      message: 'boom',
      lineNumber: 3,
      sourceId: 'https://a.test/x.js',
    });
    wc.emit('console-message', { level: 'info', message: 'hello' });
    const messages = page.consoleMessages({ limit: 10, clear: true });
    expect(messages.map((entry) => [entry.level, entry.message])).toEqual([
      ['error', 'boom'],
      ['info', 'hello'],
    ]);
    expect(page.consoleMessages()).toEqual([]);
  });

  it('evaluates in the main world with capped JSON results and clear errors', async () => {
    const { page } = setup();
    await expect(page.evaluate('({ a: [1, 2] })')).resolves.toEqual({ a: [1, 2] });
    await expect(page.evaluate('"y".repeat(30000)')).resolves.toMatch(
      /truncated: the result exceeded 20000/
    );
    await expect(page.evaluate('missing.value')).rejects.toThrow(
      /^Evaluation failed: ReferenceError/
    );
    await expect(page.evaluate('if (')).rejects.toThrow(/SyntaxError/);
    await expect(page.evaluate('  ')).rejects.toThrow(/Pass a JavaScript expression/);
  });

  it('polls for text and reports unsatisfied waits without throwing', async () => {
    const { page, handlers } = setup();
    let calls = 0;
    handlers.matchText = () => pageOk({ textFound: ++calls >= 2, textGoneAbsent: true });
    await expect(page.waitFor({ text: 'Done', timeoutMs: 2_000 })).resolves.toEqual({
      satisfied: true,
    });
    handlers.matchText = () => pageOk({ textFound: false, textGoneAbsent: true });
    await expect(page.waitFor({ text: 'Never', timeoutMs: 300 })).resolves.toEqual({
      satisfied: false,
    });
    await expect(page.waitFor({ timeMs: 10 })).resolves.toEqual({ satisfied: true });
    await expect(page.waitFor({})).rejects.toThrow(/needs text, textGone or timeMs/);
  });

  it('fails fast with a clear error when a hidden tab cannot be captured', async () => {
    vi.useFakeTimers();
    const { wc, page } = setup();
    wc.capturePageImpl = () => new Promise(() => undefined);
    const result = page.screenshot();
    const assertion = expect(result).rejects.toThrow(HIDDEN_TAB_SCREENSHOT_ERROR);
    await vi.advanceTimersByTimeAsync(3_100);
    await assertion;
  });

  it('downscales captures to CSS pixels', async () => {
    const { wc, page } = setup();
    const resized = {
      isEmpty: () => false,
      getSize: () => ({ width: 800, height: 600 }),
      toPNG: () => Buffer.from('png'),
    };
    const resize = vi.fn(() => resized);
    wc.capturePageImpl = async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 1600, height: 1200 }),
      resize,
      toPNG: () => Buffer.from('raw'),
    });
    await expect(page.screenshot()).resolves.toEqual({
      mimeType: 'image/png',
      data: Buffer.from('png').toString('base64'),
      width: 800,
      height: 600,
    });
    expect(resize).toHaveBeenCalledWith({ width: 800, height: 600, quality: 'good' });
  });
});

describe('lifecycle', () => {
  it('rejects with clear messages for crashed, destroyed and disposed pages', async () => {
    const { wc, page } = setup();
    wc.crashed = true;
    wc.emit('render-process-gone', {}, { reason: 'crashed' });
    await expect(page.snapshot()).rejects.toThrow(
      'The page has crashed (crashed); call reload or navigate to recover.'
    );
    await expect(page.reload()).resolves.toMatchObject({ url: 'https://start.test/' });
    await expect(page.getText()).rejects.toThrow(/unhandled/);

    wc.destroy();
    await expect(page.snapshot()).rejects.toThrow('The browser tab has been closed.');
    expect(() => page.consoleMessages()).toThrow('The browser tab has been closed.');
  });

  it('removes every listener and detaches its debugger session on dispose', async () => {
    const { wc, page } = setup();
    expect(wc.backgroundThrottling).toBe(false);
    await page.pressKey('Tab');
    expect(wc.debugger.attached).toBe(true);
    page.dispose();
    expect(wc.backgroundThrottling).toBe(true);
    for (const event of [
      'console-message',
      'did-navigate',
      'did-navigate-in-page',
      'render-process-gone',
      'destroyed',
    ]) {
      expect(wc.listenerCount(event)).toBe(0);
    }
    expect(wc.listenerCount('did-stop-loading')).toBe(0);
    expect(wc.debugger.attached).toBe(false);
    expect(wc.debugger.listenerCount('detach')).toBe(0);
    await expect(page.snapshot()).rejects.toThrow(/has been disposed/);
  });
});
