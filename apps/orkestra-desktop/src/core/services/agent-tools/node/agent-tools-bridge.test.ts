import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_TOOLS_BRIDGE_ENV,
  AGENT_TOOLS_BRIDGE_SOURCE,
  ensureAgentToolsBridgeScript,
  ORCHESTRA_BRIDGE_ENV,
} from './agent-tools-bridge';
import { McpBridgeClient } from './testing/mcp-bridge-client';

type RecordedRequest = {
  headers: IncomingHttpHeaders;
  body: { method: string; params: Record<string, unknown> };
};

type Reply = { status?: number; payload: unknown };

const TOKEN = 'secret-token';
const PNG = Buffer.from('fake-png-bytes').toString('base64');

/** Orkestra RPC sunucusunu taklit eden küçük bir HTTP sunucusu. */
async function startFakeRpc(
  reply: (request: RecordedRequest) => Reply,
  listenOn: { socketPath: string } | null = null
): Promise<{ server: Server; url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const recorded: RecordedRequest = {
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      requests.push(recorded);
      const { status = 200, payload } =
        request.headers.authorization === `Bearer ${TOKEN}`
          ? reply(recorded)
          : { status: 403, payload: { error: 'Forbidden' } };
      const body = JSON.stringify(payload);
      response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => {
    if (listenOn) server.listen(listenOn.socketPath, resolve);
    else server.listen(0, '127.0.0.1', resolve);
  });
  const url = listenOn ? '' : `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`;
  return { server, url, requests };
}

function browserLikeReply(request: RecordedRequest): Reply {
  if (request.body.method === 'describe') {
    return {
      payload: {
        name: 'orkestra-browser',
        instructions: 'Use the in-app browser.',
        tools: [{ name: 'screenshot', inputSchema: { type: 'object', properties: {} } }],
      },
    };
  }
  const name = request.body.params.name;
  if (name === 'screenshot') {
    return {
      payload: {
        content: [
          { type: 'text', text: 'Screenshot of http://localhost:3000/' },
          { type: 'image', data: PNG, mimeType: 'image/png' },
        ],
      },
    };
  }
  if (name === 'big') {
    return { payload: { content: [{ type: 'text', text: 'x'.repeat(6 * 1024 * 1024) }] } };
  }
  if (name === 'broken')
    return { payload: { content: [{ type: 'text', text: 'boom' }], isError: true } };
  return { status: 500, payload: { error: `unexpected tool ${String(name)}` } };
}

describe('agent tools MCP bridge', () => {
  let directory: string;
  let script: string;
  let rpc: Awaited<ReturnType<typeof startFakeRpc>> | null = null;
  let bridge: McpBridgeClient | null = null;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orkestra-agent-tools-'));
    script = await ensureAgentToolsBridgeScript(directory);
  });

  afterEach(async () => {
    bridge?.kill();
    bridge = null;
    if (rpc) await new Promise((resolve) => rpc!.server.close(resolve));
    rpc = null;
    await rm(directory, { recursive: true, force: true });
  });

  function startBridge(env: Record<string, string>): McpBridgeClient {
    bridge = McpBridgeClient.start({
      name: 'test',
      command: process.execPath,
      args: [script],
      env,
    });
    return bridge;
  }

  function toolsEnv(url: string): Record<string, string> {
    return {
      [AGENT_TOOLS_BRIDGE_ENV.url]: url,
      [AGENT_TOOLS_BRIDGE_ENV.token]: TOKEN,
      [AGENT_TOOLS_BRIDGE_ENV.server]: 'browser',
    };
  }

  it('describes the server and passes text and image content through unchanged', async () => {
    rpc = await startFakeRpc(browserLikeReply);
    const client = startBridge(toolsEnv(rpc.url));

    const init = await client.request('initialize', { protocolVersion: '2025-06-18' });
    expect(init.result).toEqual({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'orkestra-browser', version: '1.0.0' },
      instructions: 'Use the in-app browser.',
    });
    const list = await client.request('tools/list');
    expect((list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual([
      'screenshot',
    ]);

    const shot = await client.callTool('screenshot', { fullPage: true });
    expect(shot).toMatchObject({
      isError: false,
      content: [
        { type: 'text', text: 'Screenshot of http://localhost:3000/' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
      ],
    });
    const call = rpc.requests.at(-1)!;
    expect(call.body).toEqual({
      method: 'call',
      params: { name: 'screenshot', arguments: { fullPage: true } },
    });
    expect(call.headers['x-orkestra-tools-server']).toBe('browser');
  });

  it('reports tool errors and rejected requests as error results', async () => {
    rpc = await startFakeRpc(browserLikeReply);
    const client = startBridge(toolsEnv(rpc.url));
    expect(await client.callTool('broken')).toMatchObject({ isError: true, text: 'boom' });
    expect(await client.callTool('missing')).toMatchObject({
      isError: true,
      text: 'unexpected tool missing',
    });
    bridge!.kill();

    const forbidden = startBridge({ ...toolsEnv(rpc.url), [AGENT_TOOLS_BRIDGE_ENV.token]: 'nope' });
    expect(await forbidden.callTool('screenshot')).toMatchObject({
      isError: true,
      text: 'Forbidden',
    });
    const init = await forbidden.request('initialize', {});
    expect(init.error).toEqual({ code: -32603, message: 'Forbidden' });
  });

  it('relays multi-megabyte results intact', async () => {
    rpc = await startFakeRpc(browserLikeReply);
    const client = startBridge(toolsEnv(rpc.url));
    const result = await client.callTool('big');
    expect(result.isError).toBe(false);
    expect(result.text).toHaveLength(6 * 1024 * 1024);
  });

  it('flushes a pending large response before exiting when input ends', async () => {
    rpc = await startFakeRpc(browserLikeReply);
    const client = startBridge(toolsEnv(rpc.url));
    const pending = client.callTool('big');
    client.endInput();
    expect((await pending).text).toHaveLength(6 * 1024 * 1024);
    expect(await client.exited).toBe(0);
  });

  it('keeps the conductor environment names and plain text results', async () => {
    rpc = await startFakeRpc((request) =>
      request.body.method === 'describe'
        ? { payload: { instructions: 'Conduct.', tools: [] } }
        : { payload: { text: '{"ok":true}' } }
    );
    const client = startBridge({
      [ORCHESTRA_BRIDGE_ENV.url]: rpc.url,
      [ORCHESTRA_BRIDGE_ENV.token]: TOKEN,
    });
    const init = await client.request('initialize', {});
    expect(init.result).toMatchObject({
      serverInfo: { name: 'orkestra' },
      instructions: 'Conduct.',
    });
    expect(await client.callTool('list_workers')).toEqual({
      isError: false,
      content: [{ type: 'text', text: '{"ok":true}' }],
      text: '{"ok":true}',
    });
    expect(rpc.requests.every((request) => !request.headers['x-orkestra-tools-server'])).toBe(true);
  });

  it('connects over a Unix socket on remote hosts', async () => {
    const socketPath = join(directory, 'rpc.sock');
    rpc = await startFakeRpc(browserLikeReply, { socketPath });
    const client = startBridge({
      [AGENT_TOOLS_BRIDGE_ENV.socket]: socketPath,
      [AGENT_TOOLS_BRIDGE_ENV.token]: TOKEN,
      [AGENT_TOOLS_BRIDGE_ENV.server]: 'browser',
    });
    const shot = await client.callTool('screenshot');
    expect(shot.content[1]).toEqual({ type: 'image', data: PNG, mimeType: 'image/png' });
  });

  it('answers ping, ignores notifications and rejects unknown methods', async () => {
    rpc = await startFakeRpc(browserLikeReply);
    const client = startBridge(toolsEnv(rpc.url));
    client.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    client.child.stdin.write('not json\n');
    expect((await client.request('ping')).result).toEqual({});
    expect((await client.request('resources/list')).error).toEqual({
      code: -32601,
      message: 'Method not found: resources/list',
    });
    expect(rpc.requests).toHaveLength(0);
  });

  it('fails clearly without connection settings', async () => {
    const client = startBridge({});
    expect(await client.callTool('screenshot')).toMatchObject({
      isError: true,
      text: 'Orkestra connection settings are missing.',
    });
  });

  it('writes the script once, privately and atomically', async () => {
    const again = await ensureAgentToolsBridgeScript(directory);
    expect(again).toBe(script);
    expect(await readFile(script, 'utf8')).toBe(AGENT_TOOLS_BRIDGE_SOURCE);
    expect((await stat(script)).mode & 0o777).toBe(0o600);
    expect(script).toMatch(/orkestra-mcp-bridge-[0-9a-f]{12}\.cjs$/);
  });
});
