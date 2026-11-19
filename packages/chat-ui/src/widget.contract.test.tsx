/**
 * Browser contract for inline widgets. Needs real iframes and layout (`browser` project), so it is
 * not part of the node project: the pure logic (srcdoc, CSP, height messages, node mapping) is
 * covered by node tests under components/rows/widget/.
 */
import { DEFAULT_THEME } from '@core/theme';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatContext } from './chat-context';
import { createChatView } from './chat-view';
import type { TranscriptTurn } from './index';
import { createChatState } from './state/chat-state';

const cleanups: Array<() => void> = [];
const errors = vi.spyOn(console, 'error');
const settle = async (frames = 12) => {
  for (let i = 0; i < frames; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
};

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  expect(errors).not.toHaveBeenCalled();
  errors.mockClear();
});

function mount(items: TranscriptTurn['items']) {
  const context = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(context);
  // Seeding history is the same path a reloaded conversation takes.
  state.transcript.history.seed([{ id: 'widgets', seq: 0, initiator: 'agent', items }]);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:800px;height:900px';
  document.body.appendChild(host);
  const view = createChatView({ context, state, parent: host, commands: {} });
  cleanups.push(() => {
    view.dispose();
    state.dispose();
    context.dispose();
    host.remove();
  });
  return host;
}

const widgetCall = (
  id: string,
  widget: { title: string; html?: string; svg?: string },
  status: 'running' | 'done' | 'error' = 'done'
): TranscriptTurn['items'][number] => ({
  kind: 'unknown-tool-call',
  id,
  seq: 0,
  toolCallId: id,
  title: 'mcp__orkestra-widgets__show_widget',
  name: 'mcp__orkestra-widgets__show_widget',
  toolKind: 'other',
  status,
  widget,
});

describe('inline widgets', () => {
  it('draws a stored show_widget input in a locked-down iframe', async () => {
    const host = mount([
      widgetCall('w1', { title: 'Sayaç', html: '<button id="b">tıkla</button>' }),
    ]);
    await settle();
    const frame = host.querySelector('iframe')!;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(
      frame.srcdoc.startsWith(
        '<!doctype html><html lang="tr"><head><meta http-equiv="Content-Security-Policy"'
      )
    ).toBe(true);
    expect(frame.srcdoc).toContain("default-src 'none'");
    expect(host.querySelector('section[aria-label="Widget: Sayaç"]')).not.toBeNull();
  });

  it('draws svg input inside the iframe, not in the app DOM', async () => {
    const host = mount([
      widgetCall('w2', { title: 'Daire', svg: '<svg id="agent-svg" viewBox="0 0 10 10"/>' }),
    ]);
    await settle();
    expect(host.querySelector('#agent-svg')).toBeNull();
    expect(host.querySelector('iframe')?.srcdoc).toContain('id="agent-svg"');
  });

  it('follows the height reported by the iframe itself', async () => {
    const host = mount([
      widgetCall('w3', { title: 'Uzun', html: '<div style="height:300px">içerik</div>' }),
      { kind: 'message', id: 'after', seq: 1, role: 'assistant', text: 'Sonraki mesaj' },
    ]);
    await settle(30);
    const frame = host.querySelector('iframe')!;
    expect(frame.getBoundingClientRect().height).toBeGreaterThan(280);
    const next = Array.from(host.querySelectorAll('*')).find(
      (element) => element.children.length === 0 && element.textContent === 'Sonraki mesaj'
    )!;
    expect(next.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      frame.getBoundingClientRect().bottom
    );
  });

  it('ignores height messages that do not come from the iframe window', async () => {
    const host = mount([widgetCall('w4', { title: 'Sabit', html: '<div style="height:200px"/>' })]);
    await settle(30);
    const frame = host.querySelector('iframe')!;
    const before = frame.getBoundingClientRect().height;
    window.postMessage({ type: 'orkestra-widget-height', height: 700 }, '*');
    await settle(4);
    expect(frame.getBoundingClientRect().height).toBe(before);
  });

  it('shows a failed call as a normal tool row, without an iframe', async () => {
    const host = mount([widgetCall('w5', { title: 'Hata', html: '<p/>' }, 'error')]);
    await settle();
    expect(host.querySelector('iframe')).toBeNull();
  });

  it('keeps the widget visible when its call sits in a collapsed tool group', async () => {
    const host = mount([
      {
        kind: 'tool-group',
        id: 'g',
        seq: 0,
        label: 'Tools',
        groupKind: 'tool-run',
        status: 'done',
        children: [widgetCall('w6', { title: 'Grup', html: '<p>x</p>' }) as never],
      },
    ]);
    await settle();
    expect(host.querySelector('iframe')).not.toBeNull();
  });
});
