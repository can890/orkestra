import { describe, expect, it, vi } from 'vitest';
import {
  makeMcpAppHost,
  type McpAppConsentRequest,
  type McpAppHostContext,
  type McpAppHostOptions,
  type McpAppToolInfo,
} from './mcp-app-host';

const context = (
  theme: 'light' | 'dark' = 'dark',
  displayMode: 'inline' | 'fullscreen' = 'inline'
): McpAppHostContext => ({
  theme,
  styles: { variables: { '--color-background-primary': theme === 'dark' ? '#000' : '#fff' } },
  displayMode,
  availableDisplayModes: ['inline', 'fullscreen'],
  containerDimensions: { width: 600, maxHeight: 2000 },
  platform: 'desktop',
});

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

type Sent = Record<string, unknown> & {
  id?: unknown;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  params?: Record<string, unknown>;
};

function setup(overrides: Partial<McpAppHostOptions> = {}) {
  const sent: Sent[] = [];
  let theme: 'light' | 'dark' = 'dark';
  let mode: 'inline' | 'fullscreen' = 'inline';
  const tools: Record<string, McpAppToolInfo> = {
    read_weather: { callable: true, readOnly: true },
    set_alert: { callable: true, readOnly: false, title: 'Set alert' },
    model_only: { callable: false, readOnly: true },
  };
  const confirm = vi.fn(async (_request: McpAppConsentRequest) => true);
  const callTool = vi.fn(async (input: { name: string; arguments: Record<string, unknown> }) => ({
    content: [{ type: 'text', text: `called ${input.name}` }, { type: 'bogus' }],
    _meta: null as unknown as Record<string, unknown>,
  }));
  const sendMessage = vi.fn(async (_text: string) => undefined);
  const openLink = vi.fn(async (_url: string) => undefined);
  const host = makeMcpAppHost({
    app: { server: 'weather', tool: 'get_weather', csp: { connectDomains: ['https://a.test'] } },
    hostName: 'orkestra',
    hostVersion: '1.0.0',
    post: (message) => sent.push(message as Sent),
    hostContext: () => context(theme, mode),
    toolInfo: async (name) => tools[name] ?? { callable: false, readOnly: false },
    callTool,
    readResource: async ({ uri }) => ({ contents: [{ uri, text: 'r' }] }),
    confirm,
    openLink,
    sendMessage,
    requestDisplayMode: async (next) => {
      mode = next;
      return mode;
    },
    onRequestTeardown: () => undefined,
    onSizeChanged: () => undefined,
    ...overrides,
  });
  const initialize = (appCapabilities: Record<string, unknown> = {}) => {
    host.receive({
      jsonrpc: '2.0',
      id: 'init',
      method: 'ui/initialize',
      params: { protocolVersion: '2026-01-26', appCapabilities },
    });
    host.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  };
  const request = async (id: number, method: string, params: Record<string, unknown> = {}) => {
    host.receive({ jsonrpc: '2.0', id, method, params });
    await flush();
    return sent.find((message) => message.id === id);
  };
  return {
    host,
    sent,
    confirm,
    callTool,
    sendMessage,
    openLink,
    initialize,
    request,
    setTheme: (next: 'light' | 'dark') => {
      theme = next;
    },
  };
}

describe('makeMcpAppHost handshake', () => {
  it('answers ui/initialize with capabilities and context, then replays the tool call', () => {
    const { host, sent, initialize } = setup();
    host.setToolCall({
      arguments: { city: 'Oslo' },
      result: { content: [{ type: 'text', text: 'Sunny' }] },
    });
    expect(sent).toEqual([]);
    initialize({ availableDisplayModes: ['inline', 'fullscreen'] });
    const init = sent[0];
    expect(init?.id).toBe('init');
    expect(init?.result).toMatchObject({
      protocolVersion: '2026-01-26',
      hostInfo: { name: 'orkestra', version: '1.0.0' },
      hostCapabilities: {
        openLinks: {},
        serverTools: {},
        serverResources: {},
        message: { text: {} },
        sandbox: { csp: { connectDomains: ['https://a.test'] } },
      },
      hostContext: { theme: 'dark', displayMode: 'inline' },
    });
    expect(sent.slice(1).map((message) => message.method)).toEqual([
      'ui/notifications/tool-input',
      'ui/notifications/tool-result',
    ]);
    expect(sent[1]?.params).toEqual({ arguments: { city: 'Oslo' } });
  });

  it('answers an unknown protocol version with its own version', () => {
    const { host, sent } = setup();
    host.receive({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
      params: { protocolVersion: '1999-01-01' },
    });
    expect(sent[0]?.result?.protocolVersion).toBe('2026-01-26');
  });

  it('refuses requests before ui/initialize', async () => {
    const { request } = setup();
    const response = await request(5, 'tools/call', { name: 'read_weather' });
    expect(response?.error?.code).toBe(-32002);
  });

  it('delivers a late result once, and context changes only after initialization', () => {
    const { host, sent, initialize, setTheme } = setup();
    host.setToolCall({ arguments: {}, result: undefined });
    setTheme('light');
    host.updateHostContext();
    expect(sent).toEqual([]);
    initialize();
    host.setToolCall({ arguments: {}, result: { content: [] } });
    host.setToolCall({ arguments: {}, result: { content: [] } });
    expect(sent.filter((m) => m.method === 'ui/notifications/tool-result')).toHaveLength(1);
    setTheme('dark');
    host.updateHostContext();
    expect(sent.at(-1)).toMatchObject({
      method: 'ui/notifications/host-context-changed',
      params: { theme: 'dark' },
    });
  });

  it('omits the message capability when messages cannot be sent', () => {
    const { sent, initialize } = setup({ sendMessage: undefined });
    initialize();
    const capabilities = sent[0]?.result?.hostCapabilities as Record<string, unknown>;
    expect(capabilities.message).toBeUndefined();
  });
});

describe('makeMcpAppHost tool-call consent', () => {
  it('calls read-only tools without asking and normalizes the result', async () => {
    const { initialize, request, confirm, callTool } = setup();
    initialize();
    const response = await request(1, 'tools/call', {
      name: 'read_weather',
      arguments: { city: 'Oslo' },
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledWith({ name: 'read_weather', arguments: { city: 'Oslo' } });
    expect(response?.result).toEqual({ content: [{ type: 'text', text: 'called read_weather' }] });
  });

  it('asks before tools that are not read-only and runs them only when approved', async () => {
    const { initialize, request, confirm, callTool } = setup();
    initialize();
    await request(1, 'tools/call', { name: 'set_alert', arguments: { level: 3 } });
    expect(confirm).toHaveBeenCalledWith({
      kind: 'tool',
      server: 'weather',
      tool: 'set_alert',
      title: 'Set alert',
      arguments: { level: 3 },
    });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('refuses a declined tool call without running it', async () => {
    const { initialize, request, callTool } = setup({ confirm: async () => false });
    initialize();
    const response = await request(1, 'tools/call', { name: 'set_alert', arguments: {} });
    expect(response?.error).toEqual({ code: -32000, message: 'Declined by the user.' });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('refuses tools hidden from apps or unknown to the server', async () => {
    const { initialize, request, callTool, confirm } = setup();
    initialize();
    const hidden = await request(1, 'tools/call', { name: 'model_only' });
    const unknown = await request(2, 'tools/call', { name: 'nope' });
    expect(hidden?.error?.message).toBe('This app cannot call that tool.');
    expect(unknown?.error?.message).toBe('This app cannot call that tool.');
    expect(callTool).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('validates tools/call params', async () => {
    const { initialize, request } = setup();
    initialize();
    const response = await request(1, 'tools/call', { name: 'set_alert', arguments: [1] });
    expect(response?.error?.code).toBe(-32602);
  });
});

describe('makeMcpAppHost messages, links and display modes', () => {
  it('asks before every message', async () => {
    const { initialize, request, confirm, sendMessage } = setup();
    initialize();
    await request(1, 'ui/message', { role: 'user', content: [{ type: 'text', text: 'Hi' }] });
    await request(2, 'ui/message', { role: 'user', content: { type: 'text', text: 'Again' } });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenNthCalledWith(1, { kind: 'message', server: 'weather', text: 'Hi' });
    expect(sendMessage.mock.calls).toEqual([['Hi'], ['Again']]);
  });

  it('does not send a declined message', async () => {
    const { initialize, request, sendMessage } = setup({ confirm: async () => false });
    initialize();
    const response = await request(1, 'ui/message', {
      role: 'user',
      content: [{ type: 'text', text: 'Hi' }],
    });
    expect(response?.error?.message).toBe('Declined by the user.');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejects non-text or non-user messages', async () => {
    const { initialize, request, confirm } = setup();
    initialize();
    const image = await request(1, 'ui/message', {
      role: 'user',
      content: [{ type: 'image', data: 'x', mimeType: 'image/png' }],
    });
    const assistant = await request(2, 'ui/message', {
      role: 'assistant',
      content: [{ type: 'text', text: 'x' }],
    });
    expect(image?.error?.code).toBe(-32602);
    expect(assistant?.error?.code).toBe(-32602);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('opens only http(s) links', async () => {
    const { initialize, request, openLink } = setup();
    initialize();
    const ok = await request(1, 'ui/open-link', { url: 'https://example.com' });
    const bad = await request(2, 'ui/open-link', { url: 'file:///etc/passwd' });
    expect(ok?.result).toEqual({});
    expect(bad?.error?.code).toBe(-32602);
    expect(openLink.mock.calls).toEqual([['https://example.com']]);
  });

  it('switches display modes the app declared', async () => {
    const { initialize, request } = setup();
    initialize({ availableDisplayModes: ['inline'] });
    const refused = await request(1, 'ui/request-display-mode', { mode: 'fullscreen' });
    expect(refused?.result).toEqual({ mode: 'inline' });
  });

  it('grants fullscreen when both sides support it', async () => {
    const { initialize, request } = setup();
    initialize({ availableDisplayModes: ['inline', 'fullscreen'] });
    const granted = await request(1, 'ui/request-display-mode', { mode: 'fullscreen' });
    expect(granted?.result).toEqual({ mode: 'fullscreen' });
    const pip = await request(2, 'ui/request-display-mode', { mode: 'pip' });
    expect(pip?.result).toEqual({ mode: 'fullscreen' });
  });
});

describe('makeMcpAppHost refusals', () => {
  it('refuses unknown methods with method-not-found', async () => {
    const { initialize, request } = setup();
    initialize();
    for (const [index, method] of [
      'ui/download-file',
      'ui/update-model-context',
      'sampling/createMessage',
      'tools/list',
    ].entries()) {
      const response = await request(index + 10, method);
      expect(response?.error).toEqual({ code: -32601, message: `Method not found: ${method}` });
    }
  });

  it('ignores non-JSON-RPC data and rejects oversized messages', async () => {
    const { host, sent, initialize } = setup();
    initialize();
    const before = sent.length;
    host.receive('hello');
    host.receive({ method: 'ping', id: 1 });
    expect(sent.length).toBe(before);
    host.receive({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'read_weather', arguments: { big: 'x'.repeat(300 * 1024) } },
    });
    expect(sent.at(-1)).toMatchObject({ id: 9, error: { code: -32600 } });
  });

  it('stops answering after dispose', async () => {
    const { host, sent, initialize } = setup();
    initialize();
    host.dispose();
    const before = sent.length;
    host.receive({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(sent.length).toBe(before);
  });

  it('asks the app to tear down and resolves on its answer', async () => {
    const { host, sent, initialize } = setup();
    initialize();
    const done = host.teardown();
    const teardown = sent.at(-1);
    expect(teardown?.method).toBe('ui/resource-teardown');
    host.receive({ jsonrpc: '2.0', id: teardown?.id, result: {} });
    await expect(done).resolves.toBeUndefined();
  });
});
