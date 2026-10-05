import { autorun } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_ACTIVITY_HINT_MS,
  BrowserAgentActivityStore,
} from '@core/features/browser/api/browser/browser-agent-activity';
import { browserControlsRegistry } from '@core/features/browser/api/browser/browser-controls-registry';
import {
  BrowserWebviewHostStore,
  DEFAULT_HIDDEN_WEBVIEW_RECT,
} from '@core/features/browser/api/browser/browser-webview-host';
import type { BrowserWebviewAdapter } from './browser-webview-types';

const RECT = { left: 10, top: 20, width: 300, height: 200 };

describe('BrowserWebviewHostStore', () => {
  it('hides pages without a claim at their last size, or a sensible default', () => {
    const host = new BrowserWebviewHostStore();
    expect(host.placement('never-shown')).toMatchObject({
      rect: DEFAULT_HIDDEN_WEBVIEW_RECT,
      visible: false,
      interactive: false,
    });

    const claim = host.claim('browser-1', { rect: RECT, scopeId: 'scope-1' });
    expect(host.placement('browser-1')).toEqual({
      rect: RECT,
      visible: true,
      interactive: true,
      scopeId: 'scope-1',
      highlight: null,
      region: null,
    });

    claim.release();
    expect(host.placement('browser-1')).toMatchObject({ rect: RECT, visible: false });
    // Pages that were never shown borrow the last size a browser was shown at.
    expect(host.placement('other')).toMatchObject({ rect: RECT, visible: false });
  });

  it('lets the latest claim win and falls back to the previous one when it is released', () => {
    const host = new BrowserWebviewHostStore();
    const first = host.claim('browser-1', { rect: RECT });
    const second = host.claim('browser-1', { rect: { ...RECT, left: 400 } });
    expect(host.placement('browser-1').rect.left).toBe(400);

    second.release();
    expect(host.placement('browser-1').rect.left).toBe(10);
    first.release();
    second.release();
    expect(host.placement('browser-1').visible).toBe(false);
  });

  it('notifies observers only when the placement actually changes', () => {
    const host = new BrowserWebviewHostStore();
    const claim = host.claim('browser-1', { rect: RECT });
    const seen: number[] = [];
    const dispose = autorun(() => seen.push(host.placement('browser-1').rect.width));

    claim.update({ rect: { ...RECT } });
    claim.update({ rect: { ...RECT, width: 320 } });
    claim.update({ interactive: false, highlight: 'left' });

    expect(seen).toEqual([300, 320, 320]);
    expect(host.placement('browser-1')).toMatchObject({ interactive: false, highlight: 'left' });
    dispose();
  });

  it('queues load requests until the layer attaches a loader', () => {
    const host = new BrowserWebviewHostStore();
    const loader = vi.fn();
    host.load('browser-1', 'https://queued.example/');

    const detach = host.attachLoader('browser-1', loader);
    expect(loader).toHaveBeenCalledWith('https://queued.example/');
    host.load('browser-1', 'https://next.example/');
    expect(loader).toHaveBeenLastCalledWith('https://next.example/');

    detach();
    host.load('browser-1', 'https://later.example/');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('forgets everything about a closed browser', () => {
    const host = new BrowserWebviewHostStore();
    host.claim('browser-1', { rect: RECT });
    host.setRegistered('browser-1', true);

    host.forget('browser-1');

    expect(host.isRegistered('browser-1')).toBe(false);
    expect(host.placement('browser-1').visible).toBe(false);
  });
});

describe('browserControlsRegistry', () => {
  afterEach(() => browserControlsRegistry.clear());

  it('combines the layer adapter with the toolbar URL focuser', () => {
    const adapter = { reload: vi.fn() } as unknown as BrowserWebviewAdapter;
    const focus = vi.fn();
    expect(browserControlsRegistry.get('browser-1')).toBeUndefined();

    const unregisterAdapter = browserControlsRegistry.registerAdapter('browser-1', adapter);
    const unregisterFocus = browserControlsRegistry.registerUrlFocuser('browser-1', focus);
    const controls = browserControlsRegistry.get('browser-1');
    controls?.focusUrl();

    expect(controls?.adapter).toBe(adapter);
    expect(focus).toHaveBeenCalled();
    expect(browserControlsRegistry.getAdapter('browser-1')).toBe(adapter);

    unregisterAdapter();
    unregisterFocus();
    expect(browserControlsRegistry.get('browser-1')).toBeUndefined();
  });
});

describe('BrowserAgentActivityStore', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the agent hint for a while after the last activity', () => {
    vi.useFakeTimers();
    const activity = new BrowserAgentActivityStore();

    activity.markActive('browser-1');
    vi.advanceTimersByTime(AGENT_ACTIVITY_HINT_MS - 1);
    activity.markActive('browser-1');
    vi.advanceTimersByTime(AGENT_ACTIVITY_HINT_MS - 1);
    expect(activity.isActive('browser-1')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(activity.isActive('browser-1')).toBe(false);
  });

  it('remembers agent-opened tabs until they are forgotten', () => {
    const activity = new BrowserAgentActivityStore();
    activity.markAgentOpened('browser-1');
    activity.markActive('browser-1');

    activity.forget('browser-1');

    expect(activity.isAgentOpened('browser-1')).toBe(false);
    expect(activity.isActive('browser-1')).toBe(false);
  });
});
