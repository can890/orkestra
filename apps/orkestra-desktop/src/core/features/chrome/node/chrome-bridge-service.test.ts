import { hostRef, LOCAL_HOST_REF, sshConnectionIdOf } from '@orkestra/core/primitives/host/api';
import { secret, type Secret } from '@orkestra/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import type {
  AgentToolServer,
  AgentToolsBridgeHost,
} from '@core/services/agent-tools/node/agent-tools-host';
import { ACTIONS } from '../../../../../../chrome-extension/lib/policy.js';
import {
  CHROME_BRIDGE_TOKEN_SECRET,
  ChromeBridgeService,
  isSupportedPageUrl,
  type ChromeBridgeStoredSettings,
} from './chrome-bridge-service';
import { CHROME_TOOLS } from './chrome-tool-definitions';

const ORIGIN = `chrome-extension://${'p'.repeat(32)}`;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

function memorySecrets(): SecretStore & { values: Map<string, Secret<string>> } {
  const values = new Map<string, Secret<string>>();
  return {
    values,
    getSecret: async (key) => values.get(key) ?? null,
    setSecret: async (key, value) => void values.set(key, value),
    deleteSecret: async (key) => void values.delete(key),
  };
}

function fakeTools() {
  let registered: AgentToolServer | null = null;
  const host: AgentToolsBridgeHost = {
    register(server) {
      registered = server;
      return () => undefined;
    },
    bridgeServer: async (input) => ({
      name: input.name,
      command: 'node',
      args: ['bridge.js'],
      env: { token: input.token, hostKind: sshConnectionIdOf(input.host) ? 'ssh' : 'local' },
    }),
  };
  return { host, server: () => registered as AgentToolServer };
}

const context = (host = LOCAL_HOST_REF) => ({
  conversationId: 'conv-1',
  projectId: 'p',
  taskId: 't',
  workspaceId: 'w',
  host,
});

function randomTestPort(): number {
  return 20000 + Math.floor(Math.random() * 30000);
}

describe('ChromeBridgeService', () => {
  const services: ChromeBridgeService[] = [];
  const sockets: WebSocket[] = [];

  function create(
    options: {
      stored?: Partial<ChromeBridgeStoredSettings> | null;
      secure?: boolean;
      secrets?: ReturnType<typeof memorySecrets>;
      requestTimeoutMs?: number;
      connectWaitMs?: number;
    } = {}
  ) {
    const tools = fakeTools();
    const secrets = options.secrets ?? memorySecrets();
    let stored = options.stored === undefined ? { port: randomTestPort() } : options.stored;
    const service = new ChromeBridgeService({
      tools: tools.host,
      secrets,
      settings: {
        get: async () => stored,
        set: async (settings) => void (stored = settings),
      },
      isSecureStorageAvailable: () => options.secure ?? true,
      logger,
      connectWaitMs: options.connectWaitMs ?? 40,
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    });
    services.push(service);
    return { service, secrets, tools, stored: () => stored };
  }

  async function connectExtension(
    service: ChromeBridgeService,
    token?: string
  ): Promise<{ ws: WebSocket }> {
    const status = await service.getStatus();
    const ws = await dial(status.port, token);
    return { ws };
  }

  function dial(
    port: number,
    token?: string,
    onConnect?: (ws: WebSocket) => void
  ): Promise<WebSocket> {
    const protocols = token ? ['orkestra-chrome.v1', `token.${token}`] : ['orkestra-chrome.v1'];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, protocols, {
      origin: ORIGIN,
    });
    onConnect?.(ws);
    sockets.push(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (_r, response) => reject(new Error(`${response.statusCode}`)));
      ws.once('error', reject);
    });
  }

  function answer(
    ws: WebSocket,
    reply: (action: string, params: Record<string, unknown>) => object
  ) {
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as {
        type: string;
        id: string;
        action: string;
        params: Record<string, unknown>;
      };
      if (message.type === 'request') {
        ws.send(
          JSON.stringify({
            type: 'response',
            id: message.id,
            ...reply(message.action, message.params),
          })
        );
      }
    });
  }

  async function enable(service: ChromeBridgeService, port = 0) {
    const base = port || randomTestPort();
    const result = await service.configure({ enabled: true, port: base });
    if (!result.success || !result.data.listening) throw new Error('could not listen');
    return base;
  }

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await Promise.all(services.splice(0).map((service) => service.dispose()));
  });

  it('starts enabled by default on boot without requiring a token or secure storage', async () => {
    const port = randomTestPort();
    const { service } = create({ stored: { port }, secure: false });
    await service.start();
    expect(await service.getStatus()).toMatchObject({
      enabled: true,
      port,
      listening: true,
      connected: false,
      secureStorageAvailable: false,
    });
    // Oturum başladığında uzantı henüz bağlı olmasa bile MCP sunucusu konuşmaya bağlanır.
    expect(await service.conversationMcpServers(context())).toMatchObject([
      { name: 'orkestra-chrome' },
    ]);
  });

  it('does not start listening on boot when the user explicitly disabled it', async () => {
    const secrets = memorySecrets();
    secrets.values.set(CHROME_BRIDGE_TOKEN_SECRET, secret('c'.repeat(64), 'x'));
    const { service } = create({ secrets, stored: { enabled: false, port: 40123 } });
    await service.start();
    expect(await service.getStatus()).toMatchObject({
      enabled: false,
      listening: false,
      tokenSet: true,
    });
    expect(await service.conversationMcpServers(context())).toEqual([]);
  });

  it('rejects an invalid port', async () => {
    const { service } = create();
    const result = await service.configure({ port: 80 as number });
    expect(result).toMatchObject({ success: false, error: { type: 'invalid_input' } });
  });

  it('provides conversationMcpServers for both local and remote SSH workspaces while enabled', async () => {
    const { service } = create();
    await enable(service);

    const localServers = await service.conversationMcpServers(context(LOCAL_HOST_REF));
    expect(localServers).toMatchObject([{ name: 'orkestra-chrome', env: { hostKind: 'local' } }]);

    const sshServers = await service.conversationMcpServers(context(hostRef('remote', 'conn-1')));
    expect(sshServers).toMatchObject([{ name: 'orkestra-chrome', env: { hostKind: 'ssh' } }]);

    await service.configure({ enabled: false });
    expect(await service.conversationMcpServers(context(LOCAL_HOST_REF))).toEqual([]);
    expect(await service.conversationMcpServers(context(hostRef('remote', 'conn-1')))).toEqual([]);
  });

  it('closes the port and drops the extension when disabled', async () => {
    const { service } = create();
    await enable(service);
    const { ws } = await connectExtension(service);
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    const status = await service.configure({ enabled: false });
    await closed;
    expect(status).toMatchObject({
      success: true,
      data: { enabled: false, listening: false, connected: false },
    });
  });

  it('waits briefly for MV3 extension wakeup on tool call and succeeds if extension connects in time', async () => {
    const { service } = create({ connectWaitMs: 500 });
    const port = await enable(service);

    setTimeout(() => {
      void dial(port, undefined, (ws) => {
        answer(ws, () => ({
          ok: true,
          result: {
            tabs: [
              { id: 7, windowId: 1, active: true, title: 'Wakeup Tab', url: 'https://ok.test/' },
            ],
          },
        }));
      });
    }, 30);

    const res = await service.runTool('tabs_list', {});
    expect(res.isError).toBeUndefined();
    expect(JSON.stringify(res.content)).toContain('Wakeup Tab');
  });

  it('reports a busy port instead of throwing', async () => {
    const first = create();
    const port = await enable(first.service);
    const second = create();
    const result = await second.service.configure({ enabled: true, port });
    expect(result).toMatchObject({ success: true, data: { enabled: true, listening: false } });
    expect((await second.service.getStatus()).listenError).toContain(String(port));
  });

  describe('tools (all 18 MCP tools)', () => {
    it('describes all 18 tools matching the extension ACTIONS', () => {
      expect(CHROME_TOOLS).toHaveLength(18);
      expect(CHROME_TOOLS.map((tool) => tool.name).sort()).toEqual([...ACTIONS].sort());
    });

    it('validates http/https URLs and blocks chrome://, file://, devtools:// and Web Store URLs', () => {
      expect(isSupportedPageUrl('https://example.com/path')).toBe(true);
      expect(isSupportedPageUrl('http://localhost:3000/app')).toBe(true);
      expect(isSupportedPageUrl('chrome://extensions')).toBe(false);
      expect(isSupportedPageUrl('file:///etc/passwd')).toBe(false);
      expect(isSupportedPageUrl('devtools://devtools/bundled/inspector.html')).toBe(false);
      expect(
        isSupportedPageUrl('chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html')
      ).toBe(false);
      expect(isSupportedPageUrl('https://chromewebstore.google.com/detail/foo')).toBe(false);
    });

    it('returns a clear tool error when the extension is not connected after waiting', async () => {
      const { service } = create({ connectWaitMs: 25 });
      await enable(service);
      const result = await service.runTool('tabs_list', {});
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('Chrome uzantısı bağlı değil');
    });

    it('returns a tool error while the bridge is off', async () => {
      const { service } = create({ stored: { enabled: false, port: randomTestPort() } });
      await service.start();
      const result = await service.runTool('tabs_list', {});
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('turned off');
    });

    it('validates arguments before talking to the extension', async () => {
      const { service } = create();
      await enable(service);
      const { ws } = await connectExtension(service);
      const seen = vi.fn();
      answer(ws, (action) => (seen(action), { ok: true, result: {} }));
      expect((await service.runTool('click', { tab_id: 1, ref: 'e5' })).isError).toBe(true);
      expect((await service.runTool('click', { tab_id: -1, ref: 'ref_5' })).isError).toBe(true);
      expect((await service.runTool('click', { tab_id: 1 })).isError).toBe(true);
      expect((await service.runTool('type', { tab_id: 1, ref: 'ref_5' })).isError).toBe(true);
      expect((await service.runTool('tab_create', { url: 'chrome://settings' })).isError).toBe(
        true
      );
      expect((await service.runTool('navigate', { url: 'file:///etc/passwd' })).isError).toBe(true);
      expect((await service.runTool('navigate', { url: 'devtools://devtools' })).isError).toBe(
        true
      );
      expect((await service.runTool('tab_close', {})).isError).toBe(true);
      expect((await service.runTool('tab_select', {})).isError).toBe(true);
      expect((await service.runTool('find', {})).isError).toBe(true);
      expect((await service.runTool('wait_for', {})).isError).toBe(true);
      expect((await service.runTool('evaluate', { expression: '' })).isError).toBe(true);
      expect(seen).not.toHaveBeenCalled();
    });

    it('dispatches and formats all 18 tools with standardized camelCase extension parameters', async () => {
      const { service } = create();
      await enable(service);
      const { ws } = await connectExtension(service);
      const received: Array<{ action: string; params: Record<string, unknown> }> = [];

      answer(ws, (action, params) => {
        received.push({ action, params });
        switch (action) {
          case 'tabs_list':
            return {
              ok: true,
              result: {
                tabs: [
                  {
                    id: 1,
                    windowId: 1,
                    active: true,
                    supported: true,
                    url: 'https://a.test/',
                    title: 'Page A',
                  },
                ],
              },
            };
          case 'tab_create':
            return {
              ok: true,
              result: {
                tabId: 2,
                windowId: 1,
                url: 'https://b.test/',
                title: 'Page B',
                active: true,
              },
            };
          case 'tab_close':
            return { ok: true, result: { closed: true, tabId: 2 } };
          case 'tab_select':
            return {
              ok: true,
              result: {
                tabId: 1,
                windowId: 1,
                url: 'https://a.test/',
                title: 'Page A',
                active: true,
              },
            };
          case 'navigate':
            return { ok: true, result: { tabId: 1, url: 'https://a.test/next', title: 'Next' } };
          case 'read_page':
            return {
              ok: true,
              result: {
                tabId: 1,
                url: 'https://a.test/',
                title: 'Page A',
                pageText: 'Hello untrusted world',
                tree: '[ref_2] button "Go"',
                truncated: false,
                elements: [
                  {
                    ref: 'ref_1',
                    tag: 'input',
                    type: 'password',
                    name: 'Password',
                    forbidden: true,
                  },
                  { ref: 'ref_2', tag: 'button', name: 'Go' },
                ],
              },
            };
          case 'find':
            return {
              ok: true,
              result: {
                tabId: 1,
                url: 'https://a.test/',
                title: 'Page A',
                matches: [{ ref: 'ref_5', tag: 'button', role: 'button', text: 'Submit' }],
              },
            };
          case 'get_page_text':
            return {
              ok: true,
              result: {
                tabId: 1,
                url: 'https://a.test/',
                title: 'Page A',
                text: 'Clean article body',
                truncated: false,
              },
            };
          case 'click':
            return { ok: true, result: { clicked: true, tabId: 1, ref: 'ref_2', tag: 'button' } };
          case 'type':
            return { ok: true, result: { typed: true, tabId: 1, ref: 'ref_3', value: 'hello' } };
          case 'form_input':
            return {
              ok: true,
              result: { updated: true, tabId: 1, ref: 'ref_4', tag: 'select', value: 'tr' },
            };
          case 'press_key':
            return { ok: true, result: { pressed: true, tabId: 1, key: 'Enter' } };
          case 'scroll':
            return { ok: true, result: { scrolled: true, tabId: 1, scrollX: 0, scrollY: 480 } };
          case 'screenshot':
            return {
              ok: true,
              result: { dataUrl: 'data:image/png;base64,AAAA' },
            };
          case 'evaluate':
            return { ok: true, result: { tabId: 1, result: { count: 3 }, type: 'object' } };
          case 'wait_for':
            return { ok: true, result: { matched: true, tabId: 1, elapsedMs: 120 } };
          case 'console':
            return {
              ok: true,
              result: {
                tabId: 1,
                entries: [
                  { level: 'error', text: 'Boom!', url: 'https://a.test/app.js', line: 42 },
                ],
              },
            };
          case 'network':
            return {
              ok: true,
              result: {
                tabId: 1,
                requests: [
                  { method: 'POST', status: 201, url: 'https://a.test/api/items', durationMs: 35 },
                ],
              },
            };
          default:
            return { ok: true, result: { ok: true } };
        }
      });

      // 1. tabs_list
      const tabs = await service.runTool('tabs_list', {});
      expect(tabs.isError).toBeUndefined();
      expect(JSON.stringify(tabs.content)).toContain('Page A');

      // 2. tab_create
      const created = await service.runTool('tab_create', { url: 'https://b.test/', active: true });
      expect(created.isError).toBeUndefined();
      expect(JSON.stringify(created.content)).toContain('Opened tab 2');

      // 3. tab_close
      const closed = await service.runTool('tab_close', { tab_id: 2 });
      expect(closed.isError).toBeUndefined();
      expect(JSON.stringify(closed.content)).toContain('Closed tab 2');

      // 4. tab_select
      const selected = await service.runTool('tab_select', { tabId: 1 });
      expect(selected.isError).toBeUndefined();
      expect(JSON.stringify(selected.content)).toContain('Selected tab 1');

      // 5. navigate
      const navigated = await service.runTool('navigate', {
        tab_id: 1,
        url: 'https://a.test/next',
        action: 'goto',
      });
      expect(navigated.isError).toBeUndefined();
      expect(JSON.stringify(navigated.content)).toContain('https://a.test/next');

      // 6. read_page
      const page = await service.runTool('read_page', {
        tab_id: 1,
        filter: 'interactive',
        root_ref: 'ref_1',
        max_elements: 100,
      });
      const pageText = (page.content[0] as { text: string }).text;
      expect(pageText.startsWith('UNTRUSTED WEB PAGE CONTENT')).toBe(true);
      expect(pageText).toContain('ref_2 button "Go"');
      expect(pageText).toContain('protected field');

      // 7. find
      const found = await service.runTool('find', { tab_id: 1, query: 'Submit', role: 'button' });
      expect(found.isError).toBeUndefined();
      expect(JSON.stringify(found.content)).toContain('ref_5');

      // 8. get_page_text
      const textRes = await service.runTool('get_page_text', { tab_id: 1, max_chars: 5000 });
      expect(textRes.isError).toBeUndefined();
      expect(JSON.stringify(textRes.content)).toContain('Clean article body');

      // 9. click
      const clicked = await service.runTool('click', {
        tab_id: 1,
        ref: 'ref_2',
        button: 'left',
        double: false,
      });
      expect(clicked.isError).toBeUndefined();
      expect(JSON.stringify(clicked.content)).toContain('Clicked ref_2');

      // 10. type
      const typed = await service.runTool('type', {
        tab_id: 1,
        ref: 'ref_3',
        text: 'hello',
        clear: true,
        submit: true,
      });
      expect(typed.isError).toBeUndefined();

      // 11. form_input
      const formRes = await service.runTool('form_input', {
        tab_id: 1,
        ref: 'ref_4',
        value: 'tr',
      });
      expect(formRes.isError).toBeUndefined();
      expect(JSON.stringify(formRes.content)).toContain('Updated ref_4');

      // 12. press_key
      const keyRes = await service.runTool('press_key', {
        tab_id: 1,
        key: 'Enter',
        ref: 'ref_3',
        modifiers: ['Meta'],
      });
      expect(keyRes.isError).toBeUndefined();
      expect(JSON.stringify(keyRes.content)).toContain('Pressed key');

      // 13. scroll
      const scrollRes = await service.runTool('scroll', {
        tab_id: 1,
        direction: 'down',
        amount: 480,
        to_ref: 'ref_5',
      });
      expect(scrollRes.isError).toBeUndefined();
      expect(JSON.stringify(scrollRes.content)).toContain('scrollY=480');

      // 14. screenshot
      const shot = await service.runTool('screenshot', { tab_id: 1, format: 'png' });
      expect(shot.content).toContainEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });

      // 15. evaluate
      const evalRes = await service.runTool('evaluate', {
        tab_id: 1,
        expression: '({ count: 3 })',
      });
      expect(evalRes.isError).toBeUndefined();
      expect((evalRes.content[0] as { text: string }).text).toContain('"count": 3');

      // 16. wait_for
      const waitRes = await service.runTool('wait_for', {
        tab_id: 1,
        text_gone: 'Loading...',
        selector_gone: '.spinner',
        timeout_ms: 5000,
      });
      expect(waitRes.isError).toBeUndefined();
      expect(JSON.stringify(waitRes.content)).toContain('120ms');

      // 17. console
      const consoleRes = await service.runTool('console', {
        tab_id: 1,
        level: 'error',
        limit: 20,
        clear: false,
      });
      expect(consoleRes.isError).toBeUndefined();
      expect(JSON.stringify(consoleRes.content)).toContain('[ERROR] Boom!');

      // 18. network
      const netRes = await service.runTool('network', {
        tab_id: 1,
        url_filter: '/api/',
        method: 'POST',
        status: 201,
      });
      expect(netRes.isError).toBeUndefined();
      expect(JSON.stringify(netRes.content)).toContain('POST 201 https://a.test/api/items');

      // Standartlaştırılmış camelCase parametrelerin uzantıya gönderildiğini doğrula:
      expect(received.find((r) => r.action === 'read_page')?.params).toEqual({
        tabId: 1,
        filter: 'interactive',
        rootRef: 'ref_1',
        maxElements: 100,
      });
      expect(received.find((r) => r.action === 'scroll')?.params).toEqual({
        tabId: 1,
        direction: 'down',
        amount: 480,
        toRef: 'ref_5',
      });
      expect(received.find((r) => r.action === 'wait_for')?.params).toEqual({
        tabId: 1,
        textGone: 'Loading...',
        selectorGone: '.spinner',
        timeoutMs: 5000,
      });
      expect(received.find((r) => r.action === 'network')?.params).toEqual({
        tabId: 1,
        urlFilter: '/api/',
        method: 'POST',
        status: 201,
      });
    });

    it('rejects malformed extension results instead of passing them on', async () => {
      const { service } = create();
      await enable(service);
      const { ws } = await connectExtension(service);
      answer(ws, () => ({ ok: true, result: { mimeType: 'text/html', data: '<script>' } }));
      const result = await service.runTool('screenshot', { tab_id: 1 });
      expect(result.isError).toBe(true);
    });

    it('times out when the extension stays silent', async () => {
      const { service } = create({ requestTimeoutMs: 50 });
      await enable(service);
      await connectExtension(service);
      const result = await service.runTool('tabs_list', {});
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('in time');
    });
  });

  it('serves describe and call through the registered tool server with per-conversation tokens', async () => {
    const { service, tools } = create();
    await enable(service);
    await connectExtension(service);
    const [spec] = await service.conversationMcpServers(context());
    const token = spec!.env!.token!;
    const server = tools.server();
    expect(server.id).toBe('chrome');
    expect(server.authenticate(token)).toBe('conv-1');
    expect(server.authenticate('f'.repeat(64))).toBeNull();
    const described = (await server.handle('conv-1', 'describe', {})) as {
      name: string;
      tools: unknown[];
    };
    expect(described.name).toBe('orkestra-chrome');
    expect(described.tools).toHaveLength(18);
    await expect(server.handle('other', 'describe', {})).rejects.toThrow('no access');
  });
});
