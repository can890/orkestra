import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeWebContents } from './fake-web-contents.test-support';
import { resolveNavigationUrl, watchNavigation } from './navigation';

describe('resolveNavigationUrl', () => {
  it('accepts http(s), file and about:blank and completes scheme-less hosts', () => {
    expect(resolveNavigationUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(resolveNavigationUrl('localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(resolveNavigationUrl('example.com')).toBe('https://example.com/');
    expect(resolveNavigationUrl('file:///tmp/a.html')).toBe('file:///tmp/a.html');
    expect(resolveNavigationUrl('about:blank')).toBe('about:blank');
  });

  it('rejects dangerous or unsupported schemes with an English message', () => {
    for (const url of [
      'javascript:alert(1)',
      'chrome://settings',
      'devtools://x',
      'data:text/html,hi',
    ]) {
      expect(() => resolveNavigationUrl(url)).toThrow(/Unsupported URL scheme/);
    }
    expect(() => resolveNavigationUrl('about:config')).toThrow(/Unsupported URL scheme "about:"/);
    expect(() => resolveNavigationUrl('   ')).toThrow(/Missing URL/);
  });
});

describe('watchNavigation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('settles once a main-frame navigation finishes loading and removes its listeners', async () => {
    const wc = new FakeWebContents();
    const watch = watchNavigation(wc.asWebContents(), { timeoutMs: 5_000 });
    wc.emitMainFrameNavigation('https://next.test/');
    await expect(watch.outcome).resolves.toEqual({ kind: 'settled' });
    expect(wc.listenerCount('did-finish-load')).toBe(0);
    expect(wc.listenerCount('did-start-navigation')).toBe(0);
  });

  it('ignores sub-frame activity', async () => {
    vi.useFakeTimers();
    const wc = new FakeWebContents();
    const watch = watchNavigation(wc.asWebContents(), { timeoutMs: 5_000 });
    watch.armIdle(100);
    wc.emit(
      'did-start-navigation',
      { isMainFrame: false, isSameDocument: false },
      'x',
      false,
      false
    );
    wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://ads.test/', false);
    wc.emit('did-stop-loading');
    await vi.advanceTimersByTimeAsync(150);
    await expect(watch.outcome).resolves.toEqual({ kind: 'settled' });
  });

  it('reports main-frame load failures but ignores ERR_ABORTED from replaced navigations', async () => {
    const wc = new FakeWebContents();
    const watch = watchNavigation(wc.asWebContents(), { timeoutMs: 5_000 });
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }, 'a', false, true);
    wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://a.test/', true);
    wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'https://b.test/', true);
    await expect(watch.outcome).resolves.toEqual({
      kind: 'failed',
      errorCode: -102,
      errorDescription: 'ERR_CONNECTION_REFUSED',
      url: 'https://b.test/',
    });
  });

  it('settles on same-document navigations', async () => {
    const wc = new FakeWebContents();
    const watch = watchNavigation(wc.asWebContents(), { timeoutMs: 5_000 });
    wc.emit('did-navigate-in-page', {}, 'https://start.test/#a', true);
    await expect(watch.outcome).resolves.toEqual({ kind: 'settled' });
  });

  it('times out instead of hanging and reports destruction or crashes', async () => {
    vi.useFakeTimers();
    const wc = new FakeWebContents();
    const slow = watchNavigation(wc.asWebContents(), { timeoutMs: 1_000 });
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }, 'a', false, true);
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(slow.outcome).resolves.toEqual({ kind: 'timeout' });

    const crashed = watchNavigation(wc.asWebContents(), { timeoutMs: 1_000 });
    wc.emit('render-process-gone', {}, { reason: 'oom' });
    await expect(crashed.outcome).resolves.toEqual({ kind: 'crashed', reason: 'oom' });
    const closed = watchNavigation(wc.asWebContents(), { timeoutMs: 1_000 });
    wc.destroy();
    await expect(closed.outcome).resolves.toEqual({ kind: 'destroyed' });
  });

  it('waits for a load already in progress when nothing new starts', async () => {
    vi.useFakeTimers();
    const wc = new FakeWebContents();
    wc.loadingMainFrame = true;
    const watch = watchNavigation(wc.asWebContents(), { timeoutMs: 5_000 });
    watch.armIdle(100);
    await vi.advanceTimersByTimeAsync(150);
    wc.loadingMainFrame = false;
    wc.emit('did-stop-loading');
    await expect(watch.outcome).resolves.toEqual({ kind: 'settled' });
  });
});
