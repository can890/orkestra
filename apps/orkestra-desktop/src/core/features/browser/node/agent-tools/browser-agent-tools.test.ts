import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostRef, LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { ok } from '@orkestra/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentBrowserPort,
  AgentBrowserTab,
  BrowserConsoleEntry,
  BrowserDialog,
  BrowserElementTarget,
  BrowserNetworkRequest,
  BrowserNetworkResponse,
  BrowserPageAutomation,
  BrowserPageInfo,
  BrowserScreenshot,
  BrowserSnapshot,
} from '@core/primitives/browser/api/agent-browser';
import type {
  ManualPreviewServerRequest,
  PreviewServer,
} from '@core/primitives/preview-servers/api';
import type {
  AgentToolCallResult,
  ConversationToolContext,
} from '@core/services/agent-tools/api/agent-tools';
import {
  AgentToolsHost,
  type AgentToolsBridgeHost,
  type AgentToolsBridgeServerInput,
  type AgentToolServer,
} from '@core/services/agent-tools/node/agent-tools-host';
import { McpBridgeClient } from '@core/services/agent-tools/node/testing/mcp-bridge-client';
import { BrowserAgentTools } from './browser-agent-tools';
import { BROWSER_TOOLS } from './browser-tool-definitions';
import type { LoopbackForwardBackend } from './loopback-forwarding';
import { createUnavailableAgentBrowserPort } from './unavailable-browser-port';

const PNG = Buffer.from('png-bytes').toString('base64');

/** Bir sekmenin sayfası; çağrıları kaydeder ve basit bir DOM taklidi döndürür. */
class FakePage implements BrowserPageAutomation {
  readonly calls: Array<[string, ...unknown[]]> = [];
  outline = '- heading "Welcome" [ref=e1]\n- button "Sign in" [ref=e2]';
  pageText = 'Welcome\nSign in';
  consoleEntries: BrowserConsoleEntry[] = [];
  navigateError: Error | null = null;
  satisfied = true;
  selected: string[] | null = null;
  openDialog: BrowserDialog | null = null;
  requests: BrowserNetworkRequest[] = [];
  responses = new Map<string, BrowserNetworkResponse>();

  constructor(private readonly tab: AgentBrowserTab) {}

  private record(method: string, ...args: unknown[]): void {
    this.calls.push([method, ...args]);
  }

  private info(): BrowserPageInfo {
    return { url: this.tab.url, title: this.tab.title };
  }

  async navigate(url: string, options?: { timeoutMs?: number }): Promise<BrowserPageInfo> {
    this.record('navigate', url, options);
    if (this.navigateError) throw this.navigateError;
    this.tab.url = url;
    this.tab.title = `Title of ${url}`;
    return this.info();
  }
  async goBack(): Promise<BrowserPageInfo> {
    this.record('goBack');
    return this.info();
  }
  async goForward(): Promise<BrowserPageInfo> {
    this.record('goForward');
    return this.info();
  }
  async reload(): Promise<BrowserPageInfo> {
    this.record('reload');
    return this.info();
  }
  async snapshot(options?: { maxChars?: number }): Promise<BrowserSnapshot> {
    this.record('snapshot', options);
    const max = options?.maxChars ?? Infinity;
    return {
      ...this.info(),
      outline: this.outline.slice(0, max),
      truncated: this.outline.length > max,
    };
  }
  async click(target: BrowserElementTarget, options?: unknown): Promise<void> {
    this.record('click', target, options);
  }
  async hover(target: BrowserElementTarget): Promise<void> {
    this.record('hover', target);
  }
  async type(target: BrowserElementTarget | null, text: string, options?: unknown): Promise<void> {
    this.record('type', target, text, options);
  }
  async pressKey(key: string): Promise<void> {
    this.record('pressKey', key);
  }
  async scroll(options: unknown): Promise<void> {
    this.record('scroll', options);
  }
  async selectOption(target: BrowserElementTarget, values: string[]): Promise<string[]> {
    this.record('selectOption', target, values);
    return this.selected ?? values;
  }
  async waitFor(options: unknown): Promise<{ satisfied: boolean }> {
    this.record('waitFor', options);
    return { satisfied: this.satisfied };
  }
  async screenshot(options?: { fullPage?: boolean }): Promise<BrowserScreenshot> {
    this.record('screenshot', options);
    return {
      mimeType: 'image/png',
      data: PNG,
      width: 1280,
      height: options?.fullPage ? 4000 : 800,
    };
  }
  async getText(options?: { maxChars?: number }) {
    this.record('getText', options);
    const max = options?.maxChars ?? Infinity;
    return { text: this.pageText.slice(0, max), truncated: this.pageText.length > max };
  }
  async evaluate(expression: string): Promise<unknown> {
    this.record('evaluate', expression);
    return { expression, items: [1, 2] };
  }
  consoleMessages(options?: unknown): BrowserConsoleEntry[] {
    this.record('consoleMessages', options);
    return this.consoleEntries;
  }
  dialog(): BrowserDialog | null {
    return this.openDialog;
  }
  async handleDialog(options: { accept: boolean; promptText?: string }): Promise<BrowserDialog> {
    this.record('handleDialog', options);
    const dialog = this.openDialog;
    if (!dialog) throw new Error('No JavaScript dialog is open on this page.');
    this.openDialog = null;
    return dialog;
  }
  networkRequests(options?: unknown): BrowserNetworkRequest[] {
    this.record('networkRequests', options);
    return this.requests;
  }
  async networkResponse(requestId: string, options?: unknown): Promise<BrowserNetworkResponse> {
    this.record('networkResponse', requestId, options);
    const response = this.responses.get(requestId);
    if (!response) throw new Error(`Unknown request id "${requestId}".`);
    return response;
  }
  dispose(): void {}
}

/** Ana süreçteki sekme kaydının bellekteki karşılığı. */
class FakeBrowser implements AgentBrowserPort {
  readonly tabs = new Map<string, AgentBrowserTab>();
  readonly pages = new Map<string, FakePage>();
  readonly opened: Array<Parameters<AgentBrowserPort['openTab']>[0]> = [];
  readonly activated: string[] = [];
  readonly closed: string[] = [];
  private nextId = 1;

  addTab(overrides: Partial<AgentBrowserTab> = {}): AgentBrowserTab {
    const tab: AgentBrowserTab = {
      browserId: `tab-${this.nextId++}`,
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      url: 'about:blank',
      title: '',
      active: false,
      live: true,
      ...overrides,
    };
    this.tabs.set(tab.browserId, tab);
    if (tab.live) this.pages.set(tab.browserId, new FakePage(tab));
    return tab;
  }

  pageOf(browserId: string): FakePage {
    return this.pages.get(browserId)!;
  }

  listTabs(scope: { projectId: string; taskId: string }): AgentBrowserTab[] {
    return [...this.tabs.values()]
      .filter((tab) => tab.projectId === scope.projectId && tab.taskId === scope.taskId)
      .map((tab) => ({ ...tab }));
  }
  getTab(browserId: string): AgentBrowserTab | null {
    const tab = this.tabs.get(browserId);
    return tab ? { ...tab } : null;
  }
  async openTab(input: Parameters<AgentBrowserPort['openTab']>[0]): Promise<AgentBrowserTab> {
    this.opened.push(input);
    const { activate = true, url: _url, ...scope } = input;
    if (activate)
      for (const tab of this.tabs.values()) if (tab.taskId === scope.taskId) tab.active = false;
    return { ...this.addTab({ ...scope, active: activate }) };
  }
  async activateTab(browserId: string): Promise<void> {
    this.activated.push(browserId);
    const target = this.tabs.get(browserId)!;
    for (const tab of this.tabs.values()) if (tab.taskId === target.taskId) tab.active = false;
    target.active = true;
    if (!target.live) {
      // Gösterilen sekmenin sayfası biraz sonra yüklenir.
      setTimeout(() => {
        target.live = true;
        this.pages.set(browserId, new FakePage(target));
      }, 15);
    }
  }
  async closeTab(browserId: string): Promise<void> {
    this.closed.push(browserId);
    this.tabs.delete(browserId);
    this.pages.delete(browserId);
  }
  page(browserId: string): BrowserPageAutomation | null {
    return this.pages.get(browserId) ?? null;
  }
}

function createToolsHost() {
  let registered: AgentToolServer | null = null;
  const specs: AgentToolsBridgeServerInput[] = [];
  const host: AgentToolsBridgeHost = {
    register: (server) => {
      registered = server;
      return () => {
        registered = null;
      };
    },
    bridgeServer: async (input) => {
      specs.push(input);
      return {
        name: input.name,
        command: 'node',
        args: ['bridge.cjs'],
        env: { TOKEN: input.token },
      };
    },
  };
  return { host, specs, server: () => registered };
}

function createPreviewBackend() {
  const servers: PreviewServer[] = [];
  const requests: ManualPreviewServerRequest[] = [];
  const backend: LoopbackForwardBackend = {
    listForWorkspace: async () => ok([...servers]),
    forwardManual: async (request) => {
      requests.push(request);
      const server: PreviewServer = {
        id: `manual:${requests.length}`,
        kind: 'forwarded',
        projectId: request.projectId,
        workspaceId: request.workspaceId,
        source: { kind: 'manual' },
        protocol: request.protocol,
        urlPath: '/',
        status: { kind: 'ready' },
        connectionId: request.connectionId,
        remotePort: request.remotePort,
        localPort: request.remotePort + 1,
      };
      servers.push(server);
      return ok(server);
    },
  };
  return { backend, requests };
}

const context: ConversationToolContext = {
  conversationId: 'chat-1',
  projectId: 'project-1',
  taskId: 'task-1',
  workspaceId: 'workspace-1',
  host: LOCAL_HOST_REF,
};

function textOf(result: AgentToolCallResult): string {
  return result.content
    .map((item) => (item.type === 'text' ? item.text : `<${item.type}>`))
    .join('\n');
}

describe('BrowserAgentTools', () => {
  let browser: FakeBrowser;
  let tools: ReturnType<typeof createToolsHost>;
  let preview: ReturnType<typeof createPreviewBackend>;
  let service: BrowserAgentTools;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  beforeEach(() => {
    browser = new FakeBrowser();
    tools = createToolsHost();
    preview = createPreviewBackend();
    service = new BrowserAgentTools({
      tools: tools.host,
      browser,
      previewServers: preview.backend,
      logger: logger as never,
      timing: { pageReadyTimeoutMs: 500, pageReadyPollMs: 5 },
    });
  });

  afterEach(() => service.dispose());

  async function call(
    name: string,
    args: Record<string, unknown> = {},
    conversationId = 'chat-1'
  ): Promise<AgentToolCallResult> {
    return (await tools.server()!.handle(conversationId, 'call', {
      name,
      arguments: args,
    })) as AgentToolCallResult;
  }

  it('offers the orkestra-browser server to provisioned conversations', async () => {
    const [server] = await service.conversationMcpServers(context);
    expect(server).toMatchObject({ name: 'orkestra-browser' });
    expect(tools.specs[0]).toMatchObject({
      name: 'orkestra-browser',
      host: LOCAL_HOST_REF,
      serverId: 'browser',
      env: {
        url: 'ORKESTRA_TOOLS_URL',
        socket: 'ORKESTRA_TOOLS_SOCKET',
        token: 'ORKESTRA_TOOLS_TOKEN',
        server: 'ORKESTRA_TOOLS_SERVER',
      },
    });
    const token = tools.specs[0]!.token;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tools.server()!.authenticate(token)).toBe('chat-1');
    expect(tools.server()!.authenticate('other')).toBeNull();
    // Aynı konuşma aynı belirteci alır; başka konuşma farklısını.
    await service.conversationMcpServers(context);
    await service.conversationMcpServers({ ...context, conversationId: 'chat-2' });
    expect(tools.specs[1]!.token).toBe(token);
    expect(tools.specs[2]!.token).not.toBe(token);

    await expect(
      service.conversationMcpServers({ ...context, conversationId: 'chat-3', workspaceId: null })
    ).resolves.toEqual([]);
    await expect(tools.server()!.handle('chat-3', 'describe', {})).rejects.toThrow(
      'no access to the in-app browser'
    );
  });

  it('describes every tool with instructions', async () => {
    await service.conversationMcpServers(context);
    const described = (await tools.server()!.handle('chat-1', 'describe', {})) as {
      name: string;
      instructions: string;
      tools: Array<{ name: string; inputSchema: { type: string } }>;
    };
    expect(described.name).toBe('orkestra-browser');
    expect(described.instructions).toContain('in-app browser');
    expect(described.instructions).toContain('http://localhost:PORT');
    expect(described.instructions).toContain('credentials');
    expect(described.tools.map((tool) => tool.name)).toEqual([
      'tabs',
      'open_tab',
      'select_tab',
      'close_tab',
      'navigate',
      'snapshot',
      'click',
      'hover',
      'type',
      'press_key',
      'scroll',
      'select_option',
      'wait_for',
      'screenshot',
      'get_text',
      'console',
      'evaluate',
      'handle_dialog',
      'network_requests',
      'network_response',
      'record_start',
      'record_stop',
      'replay',
    ]);
    expect(described.tools.every((tool) => tool.inputSchema.type === 'object')).toBe(true);
  });

  it('opens a tab, loads the page and keeps it as the current tab', async () => {
    await service.conversationMcpServers(context);
    const opened = await call('open_tab', { url: 'localhost:3000/login' });
    expect(opened.isError).toBeFalsy();
    expect(browser.opened).toEqual([
      { projectId: 'project-1', workspaceId: 'workspace-1', taskId: 'task-1', activate: true },
    ]);
    const tabId = [...browser.tabs.keys()][0]!;
    const page = browser.pageOf(tabId);
    expect(page.calls[0]).toEqual([
      'navigate',
      'http://localhost:3000/login',
      { timeoutMs: 30_000 },
    ]);
    expect(textOf(opened)).toContain(`Opened tab ${tabId} as your current tab`);
    expect(textOf(opened)).toContain('URL: http://localhost:3000/login');
    expect(textOf(opened)).toContain('button "Sign in" [ref=e2]');

    // Kullanıcının panelde gösterdiği başka bir sekme, ajanın güncel sekmesini değiştirmez.
    const other = browser.addTab({ active: true, url: 'https://example.com/', title: 'Example' });
    browser.tabs.get(tabId)!.active = false;
    await call('click', { ref: '[ref=e2]' });
    expect(page.calls.at(-1)).toEqual(['click', { ref: 'e2' }, { clickCount: 1 }]);
    expect(browser.pageOf(other.browserId).calls).toEqual([]);

    const listed = textOf(await call('tabs'));
    expect(listed).toContain(`- ${tabId} [current]: "Title of http://localhost:3000/login"`);
    expect(listed).toContain(`- ${other.browserId} [shown]: "Example" — https://example.com/`);
  });

  it('falls back to the shown tab and explains when there is no tab', async () => {
    await service.conversationMcpServers(context);
    const missing = await call('snapshot');
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe('No browser tab is open in this task. Call open_tab to open one.');

    const hidden = browser.addTab({ title: 'Docs' });
    const none = await call('snapshot');
    expect(textOf(none)).toContain(
      `You have no current tab. Pass tab or call select_tab with one of: ${hidden.browserId} ("Docs")`
    );

    const shown = browser.addTab({ active: true, url: 'https://example.com/', title: 'Example' });
    const snap = await call('snapshot', { maxChars: 1000 });
    expect(snap.isError).toBeFalsy();
    expect(textOf(snap)).toContain('URL: https://example.com/\nTitle: Example');
    expect(browser.pageOf(shown.browserId).calls).toEqual([['snapshot', { maxChars: 1000 }]]);
    // Kullanılan sekme güncel sekme olur.
    browser.tabs.get(shown.browserId)!.active = false;
    await call('get_text');
    expect(browser.pageOf(shown.browserId).calls.at(-1)?.[0]).toBe('getText');
  });

  it("keeps tools inside the conversation's task", async () => {
    await service.conversationMcpServers(context);
    const foreign = browser.addTab({ taskId: 'task-2', active: true });
    for (const [name, args] of [
      ['snapshot', { tab: foreign.browserId }],
      ['select_tab', { tab: foreign.browserId }],
      ['close_tab', { tab: foreign.browserId }],
      ['click', { tab: foreign.browserId, ref: 'e1' }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, name).toBe(true);
      expect(textOf(result)).toBe(
        `Tab "${foreign.browserId}" is not open in this task. Call tabs to list the open tabs.`
      );
    }
    expect(browser.pageOf(foreign.browserId).calls).toEqual([]);
    expect(browser.activated).toEqual([]);
    expect(browser.closed).toEqual([]);
    expect(textOf(await call('tabs'))).toBe(
      'No browser tabs are open in this task. Call open_tab to open one.'
    );
  });

  it('selects and closes tabs', async () => {
    await service.conversationMcpServers(context);
    const first = browser.addTab({ active: true, title: 'First' });
    const second = browser.addTab({ title: 'Second' });
    const selected = await call('select_tab', { tab: second.browserId });
    expect(textOf(selected)).toContain(`Tab ${second.browserId} is now your current tab`);
    expect(browser.activated).toEqual([second.browserId]);
    await call('press_key', { key: 'Escape' });
    expect(browser.pageOf(second.browserId).calls).toEqual([['pressKey', 'Escape']]);

    const closed = await call('close_tab', { tab: second.browserId });
    expect(textOf(closed)).toBe(
      `Closed tab ${second.browserId}.\n1 tab still open in this task.\nYour next calls use the tab shown in the browser panel unless you pass tab.`
    );
    browser.tabs.get(first.browserId)!.active = true;
    await call('scroll', { direction: 'up', amount: 300 });
    expect(browser.pageOf(first.browserId).calls).toEqual([
      ['scroll', { direction: 'up', amount: 300 }],
    ]);
  });

  it('shows a tab whose page is not loaded before using it', async () => {
    await service.conversationMcpServers(context);
    const sleeping = browser.addTab({ live: false, title: 'Restored' });
    const result = await call('snapshot', { tab: sleeping.browserId });
    expect(result.isError).toBeFalsy();
    expect(browser.activated).toEqual([sleeping.browserId]);
    expect(browser.pageOf(sleeping.browserId).calls[0]?.[0]).toBe('snapshot');
  });

  it('validates arguments before touching the page', async () => {
    await service.conversationMcpServers(context);
    const tab = browser.addTab({ active: true });
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['click', {}, 'Pass ref (from snapshot) or x and y viewport coordinates.'],
      ['click', { ref: 'e1', x: 1, y: 2 }, 'Pass either ref or x and y, not both.'],
      ['click', { x: 1 }, 'Pass both x and y.'],
      ['click', { ref: 'e1', button: 'side' }, '"button" must be one of: left, right, middle.'],
      ['navigate', {}, 'Pass url, or action: back, forward or reload.'],
      [
        'navigate',
        { url: 'https://a.test', action: 'back' },
        'Pass either url or action, not both.',
      ],
      ['wait_for', {}, 'Pass text, textGone or seconds.'],
      ['wait_for', { seconds: 600 }, '"seconds" must be a number between 0 and 60.'],
      ['type', { ref: 'e1' }, '"text" is required.'],
      ['select_option', { values: ['a'] }, '"ref" is required'],
      ['select_option', { ref: 'e1', values: [] }, '"values" must be a non-empty list of strings.'],
      ['snapshot', { maxChars: 10 }, '"maxChars" must be an integer between 500 and 200000.'],
      ['evaluate', { expression: 42 }, '"expression" must be a string.'],
      ['nope', {}, 'Unknown tool: nope'],
    ];
    for (const [name, args, message] of cases) {
      const result = await call(name, args);
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(textOf(result)).toContain(message);
    }
    expect(browser.pageOf(tab.browserId).calls).toEqual([]);
  });

  it('drives the page and reports results concisely', async () => {
    await service.conversationMcpServers(context);
    const tab = browser.addTab({ active: true, url: 'https://app.test/', title: 'App' });
    const page = browser.pageOf(tab.browserId);

    expect(textOf(await call('click', { x: 10, y: 20, double: true, modifiers: ['shift'] }))).toBe(
      'Double-clicked (10, 20).\nURL: https://app.test/\nTitle: App\nTake a snapshot to see the updated page and get fresh refs.'
    );
    expect(page.calls.at(-1)).toEqual([
      'click',
      { x: 10, y: 20 },
      { clickCount: 2, modifiers: ['shift'] },
    ]);
    expect(textOf(await call('click', { ref: 'e5', button: 'right' }))).toContain(
      'Right-clicked [ref=e5].'
    );
    expect(textOf(await call('hover', { ref: 'e3' }))).toBe('Hovering over [ref=e3].');
    expect(
      textOf(await call('type', { ref: 'e4', text: 'hello', clear: true, submit: true }))
    ).toContain('Typed 5 characters into [ref=e4], replacing its value, then pressed Enter.');
    expect(page.calls.at(-1)).toEqual([
      'type',
      { ref: 'e4' },
      'hello',
      { clear: true, submit: true },
    ]);
    expect(textOf(await call('type', { text: '' }))).toBe(
      'Typed 0 characters into the focused element.'
    );
    expect(textOf(await call('select_option', { ref: 'e6', values: ['b'] }))).toBe(
      'Selected in [ref=e6]: "b".'
    );
    page.selected = [];
    expect(await call('select_option', { ref: 'e6', values: ['zz'] })).toMatchObject({
      isError: true,
    });

    expect(textOf(await call('wait_for', { text: 'Welcome', timeoutSeconds: 5 }))).toContain(
      'Done: "Welcome" is visible.'
    );
    expect(page.calls.at(-1)).toEqual(['waitFor', { text: 'Welcome', timeoutMs: 5000 }]);
    page.satisfied = false;
    expect(textOf(await call('wait_for', { textGone: 'Loading' }))).toContain(
      'Timed out after 30 s waiting until "Loading" is gone.'
    );
    expect(textOf(await call('wait_for', { seconds: 0.5 }))).toContain('Waited 0.5 s.');

    page.pageText = 'x'.repeat(600);
    expect(textOf(await call('get_text', { maxChars: 500 }))).toContain(
      '[Truncated at 500 characters; pass a larger maxChars to see more.]'
    );
    expect(textOf(await call('evaluate', { expression: 'document.title' }))).toBe(
      JSON.stringify({ expression: 'document.title', items: [1, 2] }, null, 2)
    );

    expect(textOf(await call('console'))).toBe('No console messages.');
    page.consoleEntries = [
      {
        level: 'error',
        message: 'Boom',
        source: 'app.js',
        line: 12,
        time: Date.UTC(2026, 0, 1, 10, 0, 1, 5),
      },
      { level: 'info', message: 'ready', time: Date.UTC(2026, 0, 1, 10, 0, 2) },
    ];
    expect(textOf(await call('console', { limit: 10, clear: true }))).toBe(
      '2 console messages, oldest first:\n[error] 10:00:01.005 Boom (app.js:12)\n[info] 10:00:02.000 ready\nConsole buffer cleared.'
    );
    expect(page.calls.at(-1)).toEqual(['consoleMessages', { limit: 10, clear: true }]);

    expect(textOf(await call('navigate', { action: 'back' }))).toContain('Went back.');
    expect(textOf(await call('navigate', { action: 'reload' }))).toContain('Reloaded the page.');
  });

  it('reports open dialogs in snapshots and action results and answers them', async () => {
    await service.conversationMcpServers(context);
    const tab = browser.addTab({ active: true, url: 'https://app.test/', title: 'App' });
    const page = browser.pageOf(tab.browserId);
    page.openDialog = {
      type: 'confirm',
      message: 'Delete?',
      url: 'https://app.test/',
      openedAt: 1,
    };

    const clicked = textOf(await call('click', { ref: 'e2' }));
    expect(clicked).toContain('A JavaScript confirm dialog is now open ("Delete?")');
    expect(clicked).toContain('handle_dialog');

    expect(textOf(await call('handle_dialog', {}))).toContain('"accept" is required');
    const handled = await call('handle_dialog', { accept: false });
    expect(textOf(handled)).toContain('Dismissed (cancelled) the confirm dialog "Delete?".');
    expect(page.calls.at(-1)).toEqual(['handleDialog', { accept: false }]);

    page.openDialog = { type: 'prompt', message: 'Name?', url: '', openedAt: 1 };
    expect(textOf(await call('handle_dialog', { accept: true, promptText: 'Ada' }))).toContain(
      'Accepted the prompt dialog "Name?" with "Ada".'
    );
    const again = await call('handle_dialog', { accept: true });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain('No JavaScript dialog is open');
  });

  it('lists network requests and shows a response with headers and body', async () => {
    await service.conversationMcpServers(context);
    const tab = browser.addTab({ active: true, url: 'http://localhost:3000/', title: 'App' });
    const page = browser.pageOf(tab.browserId);
    expect(textOf(await call('network_requests'))).toContain('No network requests recorded.');

    const ok: BrowserNetworkRequest = {
      requestId: '42.1',
      url: 'http://localhost:3000/api/items',
      method: 'GET',
      resourceType: 'Fetch',
      state: 'finished',
      status: 200,
      mimeType: 'application/json',
      startTime: 1,
      durationMs: 12,
      encodedSize: 2048,
    };
    page.requests = [
      ok,
      {
        requestId: '43.1',
        url: 'http://localhost:4000/down',
        method: 'POST',
        resourceType: 'XHR',
        state: 'failed',
        failure: 'net::ERR_CONNECTION_REFUSED',
        startTime: 2,
      },
    ];
    const listed = textOf(
      await call('network_requests', { filter: 'localhost', failedOnly: true, limit: 5 })
    );
    expect(listed).toContain('2 network requests (matching "localhost", failed), oldest first');
    expect(listed).toContain(
      '- [42.1] GET 200 fetch http://localhost:3000/api/items (12 ms, 2.0 kB, application/json)'
    );
    expect(listed).toContain(
      '- [43.1] POST FAILED net::ERR_CONNECTION_REFUSED xhr http://localhost:4000/down'
    );
    expect(page.calls.at(-1)).toEqual([
      'networkRequests',
      { filter: 'localhost', failedOnly: true, limit: 5, clear: false },
    ]);

    page.responses.set('42.1', {
      request: ok,
      requestHeaders: { Authorization: '[redacted]' },
      responseHeaders: { 'Content-Type': 'application/json' },
      body: { text: '{"items":[]}', truncated: true },
    });
    const detail = textOf(await call('network_response', { requestId: '42.1', maxChars: 500 }));
    expect(detail).toContain('Request headers:\n  Authorization: [redacted]');
    expect(detail).toContain('Response headers:\n  Content-Type: application/json');
    expect(detail).toContain('Response body:\n{"items":[]}\n[Truncated at 500 characters');
    expect(page.calls.at(-1)).toEqual(['networkResponse', '42.1', { maxChars: 500 }]);

    page.responses.set('43.1', {
      request: page.requests[1]!,
      requestHeaders: {},
      responseHeaders: {},
      bodyUnavailable: 'The request failed, so there is no response body.',
    });
    expect(textOf(await call('network_response', { requestId: '43.1' }))).toContain(
      'Response body not returned: The request failed'
    );
    expect((await call('network_response', {})).isError).toBe(true);
  });

  it('returns screenshots as image content', async () => {
    await service.conversationMcpServers(context);
    browser.addTab({ active: true, url: 'https://app.test/', title: 'App' });
    const result = await call('screenshot', { fullPage: true });
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'Screenshot of https://app.test/ — "App" (1280×4000 px, full page).',
        },
        { type: 'image', data: PNG, mimeType: 'image/png' },
      ],
    });
  });

  it('forwards loopback URLs of remote workspaces and annotates them', async () => {
    const remote = { ...context, host: hostRef('remote', 'conn-1') };
    await service.conversationMcpServers(remote);
    const opened = await call('open_tab', { url: 'http://localhost:3000/dashboard?x=1#top' });
    expect(preview.requests).toEqual([
      {
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        connectionId: 'conn-1',
        protocol: 'http:',
        remotePort: 3000,
      },
    ]);
    const tabId = [...browser.tabs.keys()][0]!;
    expect(browser.pageOf(tabId).calls[0]).toEqual([
      'navigate',
      'http://127.0.0.1:3001/dashboard?x=1#top',
      { timeoutMs: 30_000 },
    ]);
    expect(textOf(opened)).toContain(
      'localhost:3000 on the workspace host is forwarded over SSH to 127.0.0.1:3001 for the in-app browser.'
    );
    expect(textOf(opened)).toContain(
      'URL: http://127.0.0.1:3001/dashboard?x=1#top (remote localhost:3000)'
    );

    await call('navigate', { url: 'localhost:3000/settings' });
    expect(preview.requests).toHaveLength(1);
    expect(textOf(await call('tabs'))).toContain('(remote localhost:3000)');

    browser.pageOf(tabId).navigateError = new Error('ERR_CONNECTION_REFUSED');
    const failed = await call('navigate', { url: 'http://localhost:9000/' });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain(
      'Loading http://127.0.0.1:9001/ failed: ERR_CONNECTION_REFUSED. Check that a server is listening on port 9000 of the workspace host.'
    );
  });

  it('reports an unavailable in-app browser', async () => {
    service.dispose();
    service = new BrowserAgentTools({
      tools: tools.host,
      browser: createUnavailableAgentBrowserPort(),
      previewServers: preview.backend,
      logger: logger as never,
    });
    await service.conversationMcpServers(context);
    for (const name of ['tabs', 'open_tab', 'snapshot']) {
      expect(await call(name)).toEqual({
        content: [{ type: 'text', text: 'In-app browser is not available' }],
        isError: true,
      });
    }
  });
});

describe('BrowserAgentTools over the MCP bridge', () => {
  let directory: string;
  let host: AgentToolsHost;
  let service: BrowserAgentTools;
  let bridge: McpBridgeClient | null = null;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orkestra-browser-tools-'));
    host = new AgentToolsHost({
      localDirectory: directory,
      nodeExecutable: process.execPath,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });
  });

  afterEach(async () => {
    bridge?.kill();
    service.dispose();
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it('serves tools, annotations and screenshots end to end', async () => {
    const browser = new FakeBrowser();
    browser.addTab({ active: true, url: 'https://app.test/', title: 'App' });
    service = new BrowserAgentTools({
      tools: host,
      browser,
      previewServers: createPreviewBackend().backend,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });
    const [spec] = await service.conversationMcpServers(context);
    expect(spec?.env).toMatchObject({ ORKESTRA_TOOLS_SERVER: 'browser' });
    bridge = McpBridgeClient.start(spec!);

    const init = await bridge.request('initialize', { protocolVersion: '2025-06-18' });
    expect(init.result).toMatchObject({ serverInfo: { name: 'orkestra-browser' } });
    const list = await bridge.request('tools/list');
    const listed = (list.result as { tools: typeof BROWSER_TOOLS }).tools;
    expect(listed).toEqual(JSON.parse(JSON.stringify(BROWSER_TOOLS)));
    expect(listed.find((tool) => tool.name === 'snapshot')?.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(listed.find((tool) => tool.name === 'close_tab')?.annotations).toMatchObject({
      destructiveHint: true,
    });

    const shot = await bridge.callTool('screenshot');
    expect(shot.isError).toBe(false);
    expect(shot.content).toEqual([
      {
        type: 'text',
        text: 'Screenshot of https://app.test/ — "App" (1280×800 px, visible area).',
      },
      { type: 'image', data: PNG, mimeType: 'image/png' },
    ]);
    const failed = await bridge.callTool('click', {});
    expect(failed).toMatchObject({ isError: true });
  });
});
