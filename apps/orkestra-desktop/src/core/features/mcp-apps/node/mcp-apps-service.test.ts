import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_HOST_REF, hostRef } from '@orkestra/core/primitives/host/api';
import type { McpServer } from '@orkestra/core/primitives/mcp/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpAppsEnabledFor } from './desktop-mcp-apps';
import { McpAppsService, type McpAppConnection } from './mcp-apps-service';
import type { McpToolDefinition } from './mcp-client';
import { McpAppSnapshotStore, type McpAppSnapshot } from './snapshot-store';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const weather: McpServer = {
  name: 'weather app',
  transport: 'stdio',
  command: 'weather-mcp',
  providers: ['claude'],
};

const tools: McpToolDefinition[] = [
  { name: 'forecast', _meta: { ui: { resourceUri: 'ui://weather/app' } } },
  { name: 'refresh', annotations: { readOnlyHint: true, title: 'Refresh' } },
  { name: 'hidden', _meta: { ui: { visibility: ['model'] } } },
  { name: 'plain' },
];

function fakeConnection(overrides: Partial<McpAppConnection> = {}) {
  const connection = {
    isClosed: false,
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(async (name: string) => ({
      content: [{ type: 'text', text: `ran ${name}` }],
      _meta: null,
    })),
    readResource: vi.fn(async (uri: string) => ({
      contents: [
        {
          uri,
          mimeType: 'text/html;profile=mcp-app',
          text: '<p>weather</p>',
          _meta: { ui: { csp: { connectDomains: ['https://api.weather.test', '*'] } } },
        },
      ],
    })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
  return connection;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orkestra-mcp-apps-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup(
  options: {
    servers?: McpServer[];
    enabled?: (server: string) => boolean;
    connection?: ReturnType<typeof fakeConnection>;
  } = {}
) {
  const connection = options.connection ?? fakeConnection();
  const connect = vi.fn(async () => connection as McpAppConnection);
  const service = new McpAppsService({
    store: new McpAppSnapshotStore(root),
    isEnabled: async (server) => options.enabled?.(server) ?? true,
    listServers: async () => options.servers ?? [weather],
    connect,
    clientInfo: { name: 'orkestra', version: '9.9.9' },
    logger: logger as never,
    now: () => 1000,
  });
  return { service, connection, connect };
}

const resolveInput = {
  conversationId: 'conv-1',
  toolCallId: 'call-1',
  providerId: 'claude',
  host: LOCAL_HOST_REF,
  // Claude Code reports the sanitized name.
  server: 'weather_app',
  tool: 'forecast',
  input: { city: 'Oslo' },
  result: { content: [{ type: 'text', text: 'Sunny' }] },
};

describe('McpAppsService.resolve', () => {
  it('resolves the ui resource of the configured server and persists a snapshot', async () => {
    const { service, connection } = setup();
    const result = await service.resolve(resolveInput);
    expect(result).toEqual({
      success: true,
      data: {
        status: 'ready',
        app: expect.objectContaining({
          server: 'weather_app',
          tool: 'forecast',
          resourceUri: 'ui://weather/app',
          html: '<p>weather</p>',
          // Invalid CSP entries are dropped before anything is stored.
          csp: { connectDomains: ['https://api.weather.test'] },
          input: { city: 'Oslo' },
          live: true,
          hostVersion: '9.9.9',
        }),
      },
    });
    expect(connection.readResource).toHaveBeenCalledWith('ui://weather/app');
    const stored = await new McpAppSnapshotStore(root).read('conv-1', 'call-1');
    expect(stored?.serverName).toBe('weather app');
    expect(stored?.result).toEqual(resolveInput.result);
  });

  it('returns none for tools without an app, unknown servers, remote hosts and disabled servers', async () => {
    const { service } = setup();
    expect(await service.resolve({ ...resolveInput, toolCallId: 'x', tool: 'plain' })).toEqual({
      success: true,
      data: { status: 'none', reason: 'no-app' },
    });
    expect(await service.resolve({ ...resolveInput, toolCallId: 'y', server: 'nope' })).toEqual({
      success: true,
      data: { status: 'none', reason: 'unknown-server' },
    });
    expect(await service.resolve({ ...resolveInput, host: hostRef('remote', 'ssh-1') })).toEqual({
      success: true,
      data: { status: 'none', reason: 'remote-host' },
    });
    const off = setup({ enabled: () => false });
    expect(await off.service.resolve(resolveInput)).toEqual({
      success: true,
      data: { status: 'none', reason: 'disabled' },
    });
    await service.dispose();
  });

  it('reports an unreachable server without throwing', async () => {
    const connection = fakeConnection({
      listTools: vi.fn(async () => {
        throw new Error('spawn ENOENT');
      }),
    });
    const { service } = setup({ connection });
    expect(await service.resolve(resolveInput)).toEqual({
      success: true,
      data: { status: 'none', reason: 'unreachable' },
    });
  });

  it('shows the stored snapshot read-only once the server is gone', async () => {
    await setup().service.resolve(resolveInput);
    const { service, connect } = setup({ servers: [] });
    const result = await service.resolve({ ...resolveInput, input: undefined, result: undefined });
    expect(result.success && result.data.status === 'ready' && result.data.app.live).toBe(false);
    expect(result.success && result.data.status === 'ready' && result.data.app.input).toEqual({
      city: 'Oslo',
    });
    expect(connect).not.toHaveBeenCalled();
    expect(
      await service.callTool({
        conversationId: 'conv-1',
        toolCallId: 'call-1',
        name: 'refresh',
        arguments: {},
      })
    ).toEqual({
      success: false,
      error: {
        type: 'unreachable',
        message: 'The MCP server of this app is no longer configured.',
      },
    });
  });
});

describe('McpAppsService app requests', () => {
  const ref = { conversationId: 'conv-1', toolCallId: 'call-1' };

  it('refuses requests for calls that have no app', async () => {
    const { service } = setup();
    expect(await service.toolInfo({ ...ref, name: 'refresh' })).toEqual({
      success: false,
      error: { type: 'not-an-app', message: 'This tool call has no MCP app.' },
    });
  });

  it('reports visibility and read-only hints from the server', async () => {
    const { service } = setup();
    await service.resolve(resolveInput);
    expect(await service.toolInfo({ ...ref, name: 'refresh' })).toEqual({
      success: true,
      data: { callable: true, readOnly: true, title: 'Refresh' },
    });
    expect(await service.toolInfo({ ...ref, name: 'hidden' })).toEqual({
      success: true,
      data: { callable: false, readOnly: false },
    });
    expect(await service.toolInfo({ ...ref, name: 'missing' })).toEqual({
      success: true,
      data: { callable: false, readOnly: false },
    });
  });

  it('calls only app-visible tools on the app own server and normalizes the result', async () => {
    const { service, connection } = setup();
    await service.resolve(resolveInput);
    expect(await service.callTool({ ...ref, name: 'refresh', arguments: { a: 1 } })).toEqual({
      success: true,
      data: { content: [{ type: 'text', text: 'ran refresh' }] },
    });
    expect(await service.callTool({ ...ref, name: 'hidden', arguments: {} })).toEqual({
      success: false,
      error: { type: 'tool-not-callable', message: 'This app cannot call that tool.' },
    });
    expect(connection.callTool).toHaveBeenCalledTimes(1);
    expect(connection.callTool).toHaveBeenCalledWith('refresh', { a: 1 });
  });

  it('honours the per-server kill switch for running apps', async () => {
    let enabled = true;
    const { service } = setup({ enabled: () => enabled });
    await service.resolve(resolveInput);
    enabled = false;
    expect(await service.callTool({ ...ref, name: 'refresh', arguments: {} })).toEqual({
      success: false,
      error: {
        type: 'disabled',
        message: 'Interactive apps from this MCP server are turned off.',
      },
    });
  });

  it('reuses one connection and closes it on dispose', async () => {
    const { service, connect, connection } = setup();
    await service.resolve(resolveInput);
    await service.toolInfo({ ...ref, name: 'refresh' });
    await service.readResource({ ...ref, uri: 'ui://weather/app' });
    expect(connect).toHaveBeenCalledTimes(1);
    await service.dispose();
    expect(connection.close).toHaveBeenCalledTimes(1);
  });
});

describe('McpAppSnapshotStore', () => {
  const snapshot: McpAppSnapshot = {
    version: 1,
    conversationId: 'conv/../1',
    toolCallId: 'toolu_01',
    providerId: 'codex',
    server: 'weather',
    serverName: 'weather',
    tool: 'forecast',
    resourceUri: 'ui://weather/app',
    html: '<p>x</p>',
    csp: { connectDomains: ['https://api.weather.test'] },
    permissions: { camera: {} },
    prefersBorder: true,
    input: { city: 'Oslo' },
    result: { content: [{ type: 'text', text: 'Sunny' }], structuredContent: { t: 1 } },
    toolDefinition: { name: 'forecast' },
    createdAt: 5,
  };

  it('round-trips a snapshot without using ids as paths', async () => {
    const store = new McpAppSnapshotStore(root);
    await store.write(snapshot);
    expect(await store.read('conv/../1', 'toolu_01')).toEqual(snapshot);
    expect(await store.read('conv/../1', 'other')).toBeNull();
    const [dir] = await readdir(root);
    expect(dir).toMatch(/^[0-9a-f]{40}$/);
  });

  it('ignores corrupt or mismatched files', async () => {
    const store = new McpAppSnapshotStore(root);
    await store.write(snapshot);
    const [dir] = await readdir(root);
    const [file] = await readdir(join(root, dir ?? ''));
    const path = join(root, dir ?? '', file ?? '');
    await writeFile(path, '{not json');
    expect(await store.read('conv/../1', 'toolu_01')).toBeNull();
    await writeFile(path, JSON.stringify({ ...snapshot, toolCallId: 'someone-else' }));
    expect(await store.read('conv/../1', 'toolu_01')).toBeNull();
    await store.removeConversation('conv/../1');
    expect(await readdir(root)).toEqual([]);
  });
});

describe('mcpAppsEnabledFor', () => {
  it('applies the global toggle and per-server switches (by configured name)', () => {
    expect(mcpAppsEnabledFor({ enabled: true, disabledServers: [] }, 'weather')).toBe(true);
    expect(mcpAppsEnabledFor({ enabled: false, disabledServers: [] }, 'weather')).toBe(false);
    expect(
      mcpAppsEnabledFor({ enabled: true, disabledServers: ['weather app'] }, 'weather_app')
    ).toBe(false);
    expect(mcpAppsEnabledFor({ enabled: true, disabledServers: ['other'] }, 'weather')).toBe(true);
  });
});
