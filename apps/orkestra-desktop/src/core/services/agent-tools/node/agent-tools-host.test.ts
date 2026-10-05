import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostRef, LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TOOLS_BRIDGE_ENV, ORCHESTRA_BRIDGE_ENV } from './agent-tools-bridge';
import { AgentToolsHost, type AgentToolServer } from './agent-tools-host';
import { McpBridgeClient } from './testing/mcp-bridge-client';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function toolServer(id: string, tokens: Record<string, string>): AgentToolServer {
  return {
    id,
    authenticate: (token) => tokens[token] ?? null,
    handle: async (conversationId, method, params) =>
      method === 'describe'
        ? { name: id, instructions: `${id} tools`, tools: [] }
        : { content: [{ type: 'text', text: `${id}:${conversationId}:${String(params.name)}` }] },
  };
}

async function post(url: string, token: string, body: unknown, server?: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(server ? { 'x-orkestra-tools-server': server } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

describe('AgentToolsHost', () => {
  let directory: string;
  let host: AgentToolsHost;
  let bridge: McpBridgeClient | null = null;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orkestra-agent-tools-host-'));
    host = new AgentToolsHost({
      localDirectory: directory,
      nodeExecutable: process.execPath,
      logger: logger as never,
    });
    host.register(toolServer('orkestra', { 'conductor-token': 'conductor-1' }));
    host.register(toolServer('browser', { 'browser-token': 'chat-7' }));
  });

  afterEach(async () => {
    bridge?.kill();
    bridge = null;
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it('builds local bridge specs with each server environment', async () => {
    const browser = await host.bridgeServer({
      name: 'orkestra-browser',
      host: LOCAL_HOST_REF,
      token: 'browser-token',
      env: AGENT_TOOLS_BRIDGE_ENV,
      serverId: 'browser',
    });
    const url = await host.rpcUrl();
    expect(browser).toEqual({
      name: 'orkestra-browser',
      command: process.execPath,
      args: [expect.stringMatching(/orkestra-mcp-bridge-[0-9a-f]{12}\.cjs$/)],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ORKESTRA_TOOLS_URL: url,
        ORKESTRA_TOOLS_TOKEN: 'browser-token',
        ORKESTRA_TOOLS_SERVER: 'browser',
      },
    });
    const conductor = await host.bridgeServer({
      name: 'orkestra',
      host: LOCAL_HOST_REF,
      token: 'conductor-token',
      env: ORCHESTRA_BRIDGE_ENV,
    });
    expect(conductor?.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      ORKESTRA_ORCHESTRA_URL: url,
      ORKESTRA_ORCHESTRA_TOKEN: 'conductor-token',
    });
    // Tek betik ve tek RPC sunucusu paylaşılır.
    expect(conductor?.args).toEqual(browser?.args);
  });

  it('routes requests by token and rejects foreign or mismatched tokens', async () => {
    const url = await host.rpcUrl();
    const call = { method: 'call', params: { name: 'tabs' } };
    expect(await post(url, 'browser-token', call, 'browser')).toEqual({
      status: 200,
      body: { content: [{ type: 'text', text: 'browser:chat-7:tabs' }] },
    });
    expect(await post(url, 'conductor-token', call)).toEqual({
      status: 200,
      body: { content: [{ type: 'text', text: 'orkestra:conductor-1:tabs' }] },
    });
    // Tarayıcı belirteci şef araçlarına, şef belirteci tarayıcı araçlarına erişemez.
    expect((await post(url, 'browser-token', call, 'orkestra')).status).toBe(403);
    expect((await post(url, 'conductor-token', call, 'browser')).status).toBe(403);
    expect((await post(url, 'wrong', call)).status).toBe(403);
    expect((await post(url, '', call)).status).toBe(403);
    expect((await post(url, 'browser-token', { params: {} }, 'browser')).status).toBe(400);
    expect((await fetch(url)).status).toBe(404);
  });

  it('stops routing to a server after it unregisters', async () => {
    const unregister = host.register(toolServer('extra', { 'extra-token': 'chat-9' }));
    const url = await host.rpcUrl();
    expect((await post(url, 'extra-token', { method: 'describe' })).status).toBe(200);
    unregister();
    expect((await post(url, 'extra-token', { method: 'describe' })).status).toBe(403);
    expect(() => host.register(toolServer('browser', {}))).toThrow('already registered');
  });

  it('serves a spawned bridge end to end', async () => {
    const spec = await host.bridgeServer({
      name: 'orkestra-browser',
      host: LOCAL_HOST_REF,
      token: 'browser-token',
      env: AGENT_TOOLS_BRIDGE_ENV,
      serverId: 'browser',
    });
    bridge = McpBridgeClient.start(spec!);
    const init = await bridge.request('initialize', {});
    expect(init.result).toMatchObject({
      serverInfo: { name: 'browser' },
      instructions: 'browser tools',
    });
    expect(await bridge.callTool('snapshot')).toMatchObject({
      isError: false,
      text: 'browser:chat-7:snapshot',
    });
  });

  it('offers no bridge for remote hosts without SSH support', async () => {
    await expect(
      host.bridgeServer({
        name: 'orkestra-browser',
        host: hostRef('remote', 'conn-1'),
        token: 'browser-token',
        env: AGENT_TOOLS_BRIDGE_ENV,
        serverId: 'browser',
      })
    ).resolves.toBeNull();
  });

  it('refuses to start after disposal', async () => {
    await host.dispose();
    await expect(host.rpcUrl()).rejects.toThrow('shutting down');
  });
});
