/**
 * Uçtan uca (servis düzeyi): gerçek bir alt süreç olarak çalışan küçük bir MCP sunucusu (stdio ve
 * Streamable HTTP), sağlayıcının transcript güncellemesinden çıkarılan MCP çağrısı, ana makine
 * servisi üzerinden `ui://` kaynağının çözülmesi ve uygulamanın postMessage isteklerinin aracı
 * (broker) ile sürülmesi.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import type { McpServer } from '@orkestra/core/primitives/mcp/api';
import {
  extractMcpCall,
  injectMcpAppCsp,
  makeMcpAppHost,
  type McpAppConsentRequest,
} from '@orkestra/core/runtimes/acp/api/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpAppsService } from './mcp-apps-service';
import { McpAppSnapshotStore } from './snapshot-store';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-app-fixture-server.mjs', import.meta.url));
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

type Sent = {
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

let root: string;
const services: McpAppsService[] = [];
const children: ChildProcess[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orkestra-mcp-apps-it-'));
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  for (const child of children.splice(0)) child.kill();
  await rm(root, { recursive: true, force: true });
});

function service(servers: McpServer[]) {
  const created = new McpAppsService({
    store: new McpAppSnapshotStore(root),
    isEnabled: async () => true,
    listServers: async () => servers,
    clientInfo: { name: 'orkestra', version: '1.0.0-test' },
    logger: logger as never,
  });
  services.push(created);
  return created;
}

const stdioServer: McpServer = {
  name: 'fixture',
  transport: 'stdio',
  command: process.execPath,
  args: [FIXTURE],
  providers: ['claude'],
};

/** Claude Code'un ACP güncellemeleri: araç adı `_meta.claudeCode.toolName` içinde gelir. */
function claudeCall() {
  const started = extractMcpCall({
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_fixture',
    title: 'mcp__fixture__show_dashboard',
    rawInput: { city: 'Oslo' },
    _meta: { claudeCode: { toolName: 'mcp__fixture__show_dashboard' } },
  });
  const done = extractMcpCall({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_fixture',
    status: 'completed',
    rawOutput: [{ type: 'text', text: 'Dashboard shown' }],
    _meta: { claudeCode: { toolName: 'mcp__fixture__show_dashboard' } },
  });
  return { ...started, ...done, input: started?.input };
}

async function startHttpFixture(): Promise<string> {
  const child = spawn(process.execPath, [FIXTURE, '--http'], { stdio: ['pipe', 'pipe', 'ignore'] });
  children.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      const match = /PORT (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    child.on('exit', () => reject(new Error('fixture exited')));
  });
  return `http://127.0.0.1:${port}/mcp`;
}

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe('MCP apps end to end with a fixture MCP server', () => {
  it('resolves the ui:// resource over stdio and brokers the app requests', async () => {
    const call = claudeCall();
    expect(call).toMatchObject({
      server: 'fixture',
      tool: 'show_dashboard',
      input: { city: 'Oslo' },
    });
    const host = service([stdioServer]);
    const ref = { conversationId: 'conv-it', toolCallId: 'toolu_fixture' };

    const resolved = await host.resolve({
      ...ref,
      providerId: 'claude',
      host: LOCAL_HOST_REF,
      server: call.server ?? '',
      tool: call.tool ?? '',
      ...(call.input ? { input: call.input } : {}),
      ...(call.result ? { result: call.result } : {}),
    });
    if (!resolved.success || resolved.data.status !== 'ready') {
      throw new Error(`expected an app, got ${JSON.stringify(resolved)}`);
    }
    const app = resolved.data.app;
    expect(app).toMatchObject({
      resourceUri: 'ui://fixture/dashboard',
      live: true,
      prefersBorder: true,
      permissions: { clipboardWrite: {} },
      // `'self'` from the server is not a valid origin and is dropped.
      csp: {
        connectDomains: ['https://api.fixture.test'],
        resourceDomains: ['https://cdn.fixture.test'],
      },
    });
    expect(app.html).toContain('fixture app');
    const document = injectMcpAppCsp(app.html, app.csp);
    expect(document).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy"/);
    expect(document).toContain('connect-src https://api.fixture.test');

    // Simulated app: postMessage JSON-RPC requests through the broker.
    const sent: Sent[] = [];
    const consent: McpAppConsentRequest[] = [];
    let approve = false;
    const messages: string[] = [];
    const broker = makeMcpAppHost({
      app: { server: app.server, tool: app.tool, ...(app.csp ? { csp: app.csp } : {}) },
      hostName: 'orkestra',
      hostVersion: app.hostVersion,
      post: (message) => sent.push(message as Sent),
      hostContext: () => ({
        theme: 'dark',
        styles: { variables: {} },
        displayMode: 'inline',
        availableDisplayModes: ['inline'],
        containerDimensions: { width: 640, maxHeight: 2000 },
        platform: 'desktop',
      }),
      toolInfo: async (name) => {
        const info = await host.toolInfo({ ...ref, name });
        if (!info.success) throw new Error(info.error.message);
        return info.data;
      },
      callTool: async ({ name, arguments: args }) => {
        const result = await host.callTool({ ...ref, name, arguments: args });
        if (!result.success) throw new Error(result.error.message);
        return result.data;
      },
      readResource: async ({ uri }) => {
        const result = await host.readResource({ ...ref, uri });
        if (!result.success) throw new Error(result.error.message);
        return result.data;
      },
      confirm: async (request) => {
        consent.push(request);
        return approve;
      },
      openLink: async () => undefined,
      sendMessage: async (text) => {
        messages.push(text);
      },
      requestDisplayMode: async (mode) => mode,
      onRequestTeardown: () => undefined,
      onSizeChanged: () => undefined,
    });
    const request = async (id: number, method: string, params: Record<string, unknown> = {}) => {
      broker.receive({ jsonrpc: '2.0', id, method, params });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const answer = sent.find((message) => message.id === id);
        if (answer) return answer;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no answer for ${method}`);
    };

    broker.setToolCall({ arguments: app.input ?? {}, result: app.result });
    broker.receive({
      jsonrpc: '2.0',
      id: 0,
      method: 'ui/initialize',
      params: { protocolVersion: '2026-01-26', appCapabilities: {} },
    });
    broker.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    expect(sent.map((message) => message.method)).toEqual([
      undefined,
      'ui/notifications/tool-input',
      'ui/notifications/tool-result',
    ]);
    expect(sent[1]?.params).toEqual({ arguments: { city: 'Oslo' } });
    expect(sent[2]?.params).toEqual({ content: [{ type: 'text', text: 'Dashboard shown' }] });

    // Read-only tool: runs without asking; the fixture saw the MCP Apps client capability.
    const read = await request(1, 'tools/call', { name: 'get_data', arguments: {} });
    expect(read.result).toEqual({
      content: [{ type: 'text', text: 'counter=0' }],
      structuredContent: { counter: 0, advertisedUi: true },
    });
    expect(consent).toEqual([]);

    // Changing tool: asks; declined calls never reach the server.
    const declined = await request(2, 'tools/call', { name: 'set_value', arguments: { value: 7 } });
    expect(declined.error?.message).toBe('Declined by the user.');
    expect(consent[0]).toMatchObject({
      kind: 'tool',
      server: 'fixture',
      tool: 'set_value',
      title: 'Set value',
    });
    const unchanged = await request(3, 'tools/call', { name: 'get_data', arguments: {} });
    expect(unchanged.result?.structuredContent).toEqual({ counter: 0, advertisedUi: true });

    approve = true;
    const approved = await request(4, 'tools/call', { name: 'set_value', arguments: { value: 7 } });
    expect(approved.result).toEqual({ content: [{ type: 'text', text: 'counter set to 7' }] });
    const changed = await request(5, 'tools/call', { name: 'get_data', arguments: {} });
    expect(changed.result?.structuredContent).toEqual({ counter: 7, advertisedUi: true });

    // Hidden from apps: refused before asking and before reaching the server.
    const hidden = await request(6, 'tools/call', { name: 'model_only', arguments: {} });
    expect(hidden.error?.message).toBe('This app cannot call that tool.');
    expect(consent).toHaveLength(2);

    // Own server resource.
    const resource = await request(7, 'resources/read', { uri: 'ui://fixture/dashboard' });
    expect(JSON.stringify(resource.result)).toContain('fixture app');

    // Message: always asked.
    const message = await request(8, 'ui/message', {
      role: 'user',
      content: [{ type: 'text', text: 'Show Bergen too' }],
    });
    expect(message.result).toEqual({});
    expect(messages).toEqual(['Show Bergen too']);
    expect(consent.at(-1)).toEqual({ kind: 'message', server: 'fixture', text: 'Show Bergen too' });

    // Unknown requests are refused cleanly.
    const unknown = await request(9, 'ui/download-file', { contents: [] });
    expect(unknown.error).toEqual({ code: -32601, message: 'Method not found: ui/download-file' });

    await flush();
    await broker.teardown();

    // History: a new host without the server shows the snapshot read-only.
    const later = service([]);
    const restored = await later.resolve({
      ...ref,
      providerId: 'claude',
      host: LOCAL_HOST_REF,
      server: 'fixture',
      tool: 'show_dashboard',
    });
    expect(restored).toMatchObject({
      success: true,
      data: {
        status: 'ready',
        app: { live: false, input: { city: 'Oslo' }, html: app.html },
      },
    });
  }, 30_000);

  it('resolves and calls tools over Streamable HTTP with configured headers', async () => {
    const url = await startHttpFixture();
    const host = service([
      {
        name: 'fixture-http',
        transport: 'http',
        url,
        headers: { 'x-test': '1' },
        providers: ['codex'],
      },
    ]);
    // codex-acp wraps MCP calls as `{ server, tool, arguments }`.
    const call = extractMcpCall({
      title: 'mcp.fixture-http.show_dashboard',
      rawInput: { server: 'fixture-http', tool: 'show_dashboard', arguments: { city: 'Rome' } },
      rawOutput: { result: { content: [{ type: 'text', text: 'Dashboard shown' }] }, error: null },
      _meta: { is_mcp_tool_call: true },
    });
    const ref = { conversationId: 'conv-http', toolCallId: 'call_1' };
    const resolved = await host.resolve({
      ...ref,
      providerId: 'codex',
      host: LOCAL_HOST_REF,
      server: call?.server ?? '',
      tool: call?.tool ?? '',
      ...(call?.input ? { input: call.input } : {}),
    });
    expect(resolved).toMatchObject({
      success: true,
      data: { status: 'ready', app: { live: true, input: { city: 'Rome' } } },
    });
    expect(await host.callTool({ ...ref, name: 'get_data', arguments: {} })).toEqual({
      success: true,
      data: {
        content: [{ type: 'text', text: 'counter=0' }],
        structuredContent: { counter: 0, advertisedUi: true },
      },
    });
  }, 30_000);

  it('degrades to no app when the server cannot start', async () => {
    const host = service([{ ...stdioServer, command: join(root, 'does-not-exist'), args: [] }]);
    const resolved = await host.resolve({
      conversationId: 'conv-x',
      toolCallId: 'call-x',
      providerId: 'claude',
      host: LOCAL_HOST_REF,
      server: 'fixture',
      tool: 'show_dashboard',
    });
    expect(resolved).toEqual({ success: true, data: { status: 'none', reason: 'unreachable' } });
  }, 30_000);
});
