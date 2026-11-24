/**
 * Browser contract for MCP apps: a real sandboxed iframe runs a tiny MCP app that speaks the
 * postMessage JSON-RPC protocol to the host. Needs real iframes (`browser` project); the pure
 * logic (CSP, document link, broker) is covered by node tests.
 */
import { DEFAULT_THEME } from '@core/theme';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatContext } from './chat-context';
import { createChatView } from './chat-view';
import type { ChatMcpAppHost, ChatMcpAppView } from './commands';
import type { TranscriptTurn } from './index';
import { createChatState } from './state/chat-state';

const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

const settle = async (frames = 12) => {
  for (let i = 0; i < frames; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
};

async function until(check: () => boolean, timeoutMs = 5000) {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A minimal MCP app: initializes, reports its size, then calls two tools and posts a message. */
const APP_HTML = `<!doctype html><html><body><div id="out">app</div><script>
var next = 1, pending = {};
function request(method, params) {
  var id = next++;
  return new Promise(function (resolve) {
    pending[id] = resolve;
    window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params }, '*');
  });
}
function notify(method, params) {
  window.parent.postMessage({ jsonrpc: '2.0', method: method, params: params }, '*');
}
window.addEventListener('message', function (event) {
  if (event.source !== window.parent) return;
  var m = event.data;
  if (!m || m.jsonrpc !== '2.0') return;
  if (m.id !== undefined && pending[m.id]) { pending[m.id](m); delete pending[m.id]; return; }
  if (m.method === 'ui/notifications/tool-result') {
    request('tools/call', { name: 'refresh', arguments: { city: 'Oslo' } }).then(function () {
      return request('tools/call', { name: 'set_alert', arguments: { level: 3 } });
    }).then(function () {
      return request('ui/message', { role: 'user', content: [{ type: 'text', text: 'From app' }] });
    });
  }
});
request('ui/initialize', { protocolVersion: '2026-01-26', appCapabilities: {} }).then(function () {
  notify('ui/notifications/initialized', {});
  notify('ui/notifications/size-changed', { height: 240 });
});
</script></body></html>`;

const view: ChatMcpAppView = {
  server: 'weather',
  tool: 'forecast',
  resourceUri: 'ui://weather/app',
  html: APP_HTML,
  input: { city: 'Oslo' },
  live: true,
};

function mount(host: ChatMcpAppHost, prefix: string) {
  const items: TranscriptTurn['items'] = [
    {
      kind: 'unknown-tool-call',
      id: `${prefix}-mcp`,
      seq: 0,
      toolCallId: 'call-1',
      title: 'mcp__weather__forecast',
      name: 'mcp__weather__forecast',
      toolKind: 'other',
      status: 'done',
      mcpCall: {
        server: 'weather',
        tool: 'forecast',
        input: { city: 'Oslo' },
        result: { content: [{ type: 'text', text: 'Sunny' }] },
      },
    },
    {
      kind: 'unknown-tool-call',
      id: `${prefix}-plain`,
      seq: 1,
      toolCallId: 'call-2',
      title: 'mcp__weather__plain',
      name: 'mcp__weather__plain',
      toolKind: 'other',
      status: 'done',
      mcpCall: { server: 'weather', tool: 'plain' },
    },
  ];
  const context = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(context);
  state.transcript.history.seed([{ id: 'apps', seq: 0, initiator: 'agent', items }]);
  const parent = document.createElement('div');
  parent.style.cssText = 'position:fixed;inset:0;width:800px;height:900px';
  document.body.appendChild(parent);
  const chat = createChatView({ context, state, parent, commands: { mcpApps: host } });
  cleanups.push(() => {
    chat.dispose();
    state.dispose();
    context.dispose();
    parent.remove();
  });
  return parent;
}

describe('MCP apps', () => {
  it('runs the app in a locked-down frame and brokers its requests with consent', async () => {
    const callTool = vi.fn(async (_call: unknown, name: string, _args: unknown) => ({
      content: [{ type: 'text', text: `ran ${name}` }],
    }));
    const sendMessage = vi.fn(async (_text: string) => undefined);
    const resolve = vi.fn(async (call: { tool: string }) =>
      call.tool === 'forecast' ? view : null
    );
    const host: ChatMcpAppHost = {
      hostName: 'orkestra',
      hostVersion: '1.0.0',
      resolve,
      toolInfo: async (_call, name) =>
        name === 'refresh'
          ? { callable: true, readOnly: true }
          : { callable: true, readOnly: false, title: 'Set alert' },
      callTool,
      readResource: async () => ({ contents: [] }),
      openLink: async () => undefined,
      sendMessage,
    };
    const parent = mount(host, 'a');
    await settle();

    expect(resolve).toHaveBeenCalledTimes(2);
    const frames = parent.querySelectorAll('iframe');
    // The call without an app keeps its plain tool row and gets no frame.
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    expect(
      frame.srcdoc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')
    ).toBe(true);
    expect(frame.srcdoc).toContain("connect-src 'none'");

    // Read-only tool: called without asking.
    await until(() => callTool.mock.calls.length === 1);
    expect(callTool.mock.calls[0]?.[1]).toBe('refresh');
    expect(callTool.mock.calls[0]?.[2]).toEqual({ city: 'Oslo' });

    // Changing tool: the card asks first.
    await until(() => parent.querySelector('[role="dialog"]') !== null);
    const dialog = parent.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Allow weather to run Set alert?');
    expect(callTool).toHaveBeenCalledTimes(1);
    const allow = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent === 'Allow'
    )!;
    allow.click();
    await until(() => callTool.mock.calls.length === 2);
    expect(callTool.mock.calls[1]?.[1]).toBe('set_alert');

    // Message: asked every time; denying keeps it out of the conversation.
    await until(
      () => parent.querySelector('[role="dialog"]')?.textContent?.includes('From app') ?? false
    );
    const deny = Array.from(parent.querySelectorAll('[role="dialog"] button')).find(
      (button) => button.textContent === 'Deny'
    ) as HTMLButtonElement;
    deny.click();
    await settle(4);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(parent.querySelector('[role="dialog"]')).toBeNull();

    // The app's reported height sizes the card.
    expect(frame.getBoundingClientRect().height).toBeGreaterThan(200);
  });

  it('ignores requests that do not come from the app document', async () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    const host: ChatMcpAppHost = {
      hostName: 'orkestra',
      hostVersion: '1.0.0',
      resolve: async () => ({ ...view, html: '<p>idle app</p>' }),
      toolInfo: async () => ({ callable: true, readOnly: true }),
      callTool,
      readResource: async () => ({ contents: [] }),
      openLink: async () => undefined,
    };
    mount(host, 'b');
    await settle();
    window.postMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'refresh', arguments: {} } },
      '*'
    );
    await settle(6);
    expect(callTool).not.toHaveBeenCalled();
  });
});
