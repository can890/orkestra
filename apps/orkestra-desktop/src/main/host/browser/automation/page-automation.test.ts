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

describe('JavaScript dialogs', () => {
  function openDialog(wc: FakeWebContents, params: Record<string, unknown> = {}) {
    wc.debugger.emit('message', {}, 'Page.javascriptDialogOpening', {
      url: 'https://start.test/',
      message: 'Delete everything?',
      type: 'confirm',
      hasBrowserHandler: true,
      ...params,
    });
  }

  it('enables Page events and reports an open dialog in snapshots instead of running scripts', async () => {
    const { wc, page } = setup();
    await vi.waitFor(() =>
      expect(wc.debugger.commands.map((command) => command.method)).toContain('Page.enable')
    );
    openDialog(wc);

    const snapshot = await page.snapshot();

    expect(snapshot.dialog).toMatchObject({ type: 'confirm', message: 'Delete everything?' });
    expect(snapshot.outline).toContain('JavaScript confirm dialog is open');
    expect(snapshot.outline).toContain('handle_dialog');
    expect(wc.pageCommands).toEqual([]);
    expect(page.dialog?.()).toMatchObject({ type: 'confirm' });
  });

  it('fails page operations fast while a dialog blocks the page', async () => {
    const { wc, page } = setup();
    await page.snapshot();
    openDialog(wc, { type: 'alert', message: 'Saved' });

    await expect(page.click({ ref: 'e1' })).rejects.toThrow(
      /JavaScript alert dialog is open \("Saved"\).*handle_dialog/
    );
    await expect(page.evaluate('1 + 1')).rejects.toThrow(/alert dialog is open/);
  });

  it('rejects an operation that is waiting on the page when a dialog opens', async () => {
    const { wc, page, handlers } = setup();
    handlers.snapshot = () => new Promise<PageResult>(() => undefined) as unknown as PageResult;
    const pending = page.snapshot();
    await vi.waitFor(() => expect(wc.pageCommands).toHaveLength(1));

    openDialog(wc, { type: 'prompt', message: 'Name?', defaultPrompt: 'Ada' });

    await expect(pending).rejects.toThrow(/prompt dialog is open/);
  });

  it('handles dialogs through DevTools without waiting for queued operations', async () => {
    const { wc, page } = setup();
    openDialog(wc, { type: 'prompt', message: 'Name?', defaultPrompt: 'Ada' });

    await expect(page.handleDialog?.({ accept: true, promptText: 'Grace' })).resolves.toMatchObject(
      { type: 'prompt', defaultPrompt: 'Ada' }
    );
    expect(wc.debugger.commands).toContainEqual({
      method: 'Page.handleJavaScriptDialog',
      params: { accept: true, promptText: 'Grace' },
    });
    expect(page.dialog?.()).toBeNull();
    await expect(page.handleDialog?.({ accept: false })).rejects.toThrow(/No JavaScript dialog/);
  });

  it('clears the dialog when the page closes it and explains an already closed dialog', async () => {
    const { wc, page } = setup();
    openDialog(wc);
    wc.debugger.emit('message', {}, 'Page.javascriptDialogClosed', { result: false });
    expect(page.dialog?.()).toBeNull();

    openDialog(wc);
    wc.debugger.respond = async (method) => {
      if (method === 'Page.handleJavaScriptDialog') throw new Error('No dialog is showing');
      return {};
    };
    await expect(page.handleDialog?.({ accept: true })).rejects.toThrow(/already closed/);
    expect(page.dialog?.()).toBeNull();
  });
});

describe('network capture', () => {
  function emitRequest(wc: FakeWebContents, id: string, mimeType = 'application/json') {
    wc.debugger.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: id,
      request: { url: `https://api.test/${id}`, method: 'GET', headers: {} },
      type: 'Fetch',
      timestamp: 1,
      wallTime: 1_700_000_000,
    });
    wc.debugger.emit('message', {}, 'Network.responseReceived', {
      requestId: id,
      type: 'Fetch',
      response: { status: 200, mimeType, headers: { 'set-cookie': 'sid=1' } },
    });
    wc.debugger.emit('message', {}, 'Network.loadingFinished', {
      requestId: id,
      timestamp: 1.5,
      encodedDataLength: 10,
    });
  }

  it('collects requests only after capture starts and enables the Network domain once', async () => {
    const { wc, page } = setup();
    emitRequest(wc, 'before');
    expect(page.networkRequests?.()).toEqual([]);

    page.startNetworkCapture();
    page.startNetworkCapture();
    emitRequest(wc, 'after');

    expect(page.networkRequests?.()).toEqual([
      expect.objectContaining({ requestId: 'after', status: 200, durationMs: 500 }),
    ]);
    await vi.waitFor(() =>
      expect(
        wc.debugger.commands.filter((command) => command.method === 'Network.enable')
      ).toHaveLength(1)
    );
  });

  it('returns redacted headers and a size-capped text body', async () => {
    const { wc, page } = setup();
    page.startNetworkCapture();
    emitRequest(wc, 'json');
    wc.debugger.respond = async (method, params) => {
      if (method === 'Network.getResponseBody') {
        expect(params).toEqual({ requestId: 'json' });
        return { body: Buffer.from('{"items":[1,2,3]}').toString('base64'), base64Encoded: true };
      }
      return {};
    };

    const full = await page.networkResponse?.('json');
    expect(full?.body).toEqual({ text: '{"items":[1,2,3]}', truncated: false });
    expect(full?.responseHeaders).toEqual({ 'set-cookie': '[redacted]' });

    wc.debugger.respond = async () => ({ body: 'x'.repeat(300), base64Encoded: false });
    const capped = await page.networkResponse?.('json', { maxChars: 100 });
    expect(capped?.body).toEqual({ text: 'x'.repeat(100), truncated: true });
  });

  it('does not fetch binary bodies and explains unknown ids and evicted bodies', async () => {
    const { wc, page } = setup();
    page.startNetworkCapture();
    emitRequest(wc, 'image', 'image/png');
    emitRequest(wc, 'gone');
    wc.debugger.respond = async (method) => {
      if (method === 'Network.getResponseBody')
        throw new Error('No resource with given identifier');
      return {};
    };

    const image = await page.networkResponse?.('image');
    expect(image?.body).toBeUndefined();
    expect(image?.bodyUnavailable).toMatch(/Only text bodies.*image\/png/);
    expect((await page.networkResponse?.('gone'))?.bodyUnavailable).toMatch(/no longer holds/);
    await expect(page.networkResponse?.('missing')).rejects.toThrow(/Unknown request id/);
  });
});

describe('recording', () => {
  function describeHandler(command: PageCommand): PageResult {
    if (command.kind !== 'describe') return { ok: false, error: 'unexpected' };
    const target = command.target as { ref?: string } | null;
    if (target?.ref === 'e9') {
      return pageOk({
        selector: 'input[name="pw"]',
        text: 'Password',
        secret: true,
        editable: 'text',
      });
    }
    return pageOk({ selector: '#go', text: 'Go', secret: false, editable: 'none' });
  }

  it("records the agent's actions as locator-based steps", async () => {
    const { page, handlers } = setup();
    handlers.describe = describeHandler;
    handlers.prepareType = () =>
      pageOk({ focused: true, point: null, occlusion: null, mode: 'value', label: 'e9' });
    handlers.setValue = () => pageOk({ value: 'x' });
    handlers.selectOption = () => pageOk({ selected: ['de'] });

    await expect(page.startRecording?.()).resolves.toEqual({
      recording: true,
      includesUser: false,
      stepCount: 1,
    });
    await expect(page.startRecording?.()).rejects.toThrow(/already running/);
    await page.snapshot();
    await page.click({ ref: 'e1' }, { clickCount: 2 });
    await page.type({ ref: 'e9' }, 'hunter2', { clear: true });
    await page.pressKey('Enter');
    await page.selectOption({ ref: 'e1' }, ['Germany']);
    await page.scroll({ direction: 'down', amount: 300 });
    await page.waitFor({ timeMs: 10 });
    await page.navigate('https://next.test/');

    const steps = await page.stopRecording?.();

    expect(steps).toEqual([
      { action: 'navigate', url: 'https://start.test/' },
      { action: 'click', target: { selector: '#go', text: 'Go' }, clickCount: 2 },
      {
        action: 'type',
        target: { selector: 'input[name="pw"]', text: 'Password' },
        text: '',
        clear: true,
        secret: true,
      },
      { action: 'press', key: 'Enter' },
      { action: 'select', target: { selector: '#go', text: 'Go' }, values: ['de'] },
      { action: 'scroll', direction: 'down', amount: 300 },
      { action: 'wait', ms: 10 },
      { action: 'navigate', url: 'https://next.test/' },
    ]);
    expect(page.recordingStatus?.()).toEqual({
      recording: false,
      includesUser: false,
      stepCount: 8,
    });
    expect(page.recordedSteps?.()).toEqual(steps);
    await expect(page.stopRecording?.()).rejects.toThrow(/No recording/);
  });

  it('accepts locator targets without a snapshot and records them as given', async () => {
    const { wc, page } = setup();
    await page.startRecording?.();
    await page.click({ selector: '.save', text: 'Save' });
    expect(wc.pageCommands[0]).toMatchObject({
      kind: 'locate',
      target: { selector: '.save', text: 'Save' },
    });
    expect((await page.stopRecording?.())?.at(-1)).toEqual({
      action: 'click',
      target: { selector: '.save', text: 'Save' },
    });
  });

  it("records the user's page actions but not the agent's own input", async () => {
    const { wc, page, handlers } = setup();
    handlers.describe = describeHandler;
    await page.startRecording?.({ includeUser: true });
    const nonce = wc.recorderCalls[0]?.nonce ?? '';
    expect(wc.recorderCalls[0]).toEqual({ nonce, mode: 'start' });
    const userMessage = (step: Record<string, unknown>, at = Date.now()) =>
      wc.emit('console-message', {
        level: 'debug',
        message: `orkestra-recorder:${nonce}:${JSON.stringify({ at, step })}`,
      });

    userMessage({ action: 'click', target: { selector: '#a', text: 'A' } });
    userMessage({ action: 'click', target: { selector: '#a', text: 'A' }, clickCount: 2 });
    userMessage({ action: 'bogus' });
    // Başka bir kaydın (eski nonce) mesajı ne adım olur ne de ajanın konsoluna düşer.
    wc.emit('console-message', { level: 'debug', message: 'orkestra-recorder:old:{}' });

    // Adres çubuğundan gezinme kaydedilir; sayfanın başlattığı (bağlantı) gezinme kaydedilmez.
    wc.emit('did-navigate', {}, 'https://typed.test/', 200, 'OK');
    wc.emit('will-navigate', {}, 'https://link.test/');
    wc.emit('did-navigate', {}, 'https://link.test/', 200, 'OK');
    wc.emit('dom-ready');

    const before = Date.now();
    await page.snapshot();
    await page.click({ ref: 'e1' });
    // Ajanın tıklaması sayfada da bir tıklama olayı üretir; kullanıcı adımı sayılmaz.
    userMessage({ action: 'click', target: { selector: '#agent' } }, before + 1);
    wc.recorderStopResult = [
      `orkestra-recorder:${nonce}:${JSON.stringify({
        at: Date.now() + 5_000,
        step: { action: 'type', target: { selector: '#q' }, text: 'shoes', clear: true },
      })}`,
    ];

    const steps = await page.stopRecording?.();

    expect(steps).toEqual([
      { action: 'navigate', url: 'https://start.test/' },
      { action: 'click', target: { selector: '#a', text: 'A' }, clickCount: 2 },
      { action: 'navigate', url: 'https://typed.test/' },
      { action: 'click', target: { selector: '#go', text: 'Go' } },
      { action: 'type', target: { selector: '#q' }, text: 'shoes', clear: true },
    ]);
    expect(wc.recorderCalls.map((call) => call.mode)).toEqual(['start', 'start', 'stop']);
    expect(page.consoleMessages()).toEqual([]);
  });
});
