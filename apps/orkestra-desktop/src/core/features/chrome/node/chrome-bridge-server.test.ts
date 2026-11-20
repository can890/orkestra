import { connect as netConnect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { ChromeBridgeError, ChromeBridgeServer } from './chrome-bridge-server';

const TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

type Outcome = { kind: 'open'; ws: WebSocket } | { kind: 'refused'; status: number };

function dial(
  port: number,
  options: {
    origin?: string | null;
    token?: string | null;
    protocols?: string[];
    headers?: Record<string, string>;
  } = {}
): Promise<Outcome> {
  const protocols =
    options.protocols ??
    (options.token === null || options.token === undefined
      ? ['orkestra-chrome.v1']
      : ['orkestra-chrome.v1', `token.${options.token}`]);
  const origin = options.origin === null ? undefined : (options.origin ?? ORIGIN);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, protocols, {
    ...(origin ? { origin } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
  });
  return new Promise((resolve) => {
    ws.once('open', () => resolve({ kind: 'open', ws }));
    ws.once('unexpected-response', (_request, response) =>
      resolve({ kind: 'refused', status: response.statusCode ?? 0 })
    );
    ws.once('error', () => undefined);
  });
}

function waitClosed(ws: WebSocket): Promise<void> {
  if (ws.readyState === 3) return Promise.resolve();
  return new Promise((resolve) => ws.once('close', () => resolve()));
}

/** Gelen istekleri `reply` ile yanıtlayan sahte uzantı. */
function fakeExtension(
  ws: WebSocket,
  reply: (message: { id: string; action: string; params: Record<string, unknown> }) => unknown
): void {
  ws.on('message', (raw) => {
    const message = JSON.parse(String(raw)) as {
      type: string;
      id: string;
      action: string;
      params: Record<string, unknown>;
    };
    if (message.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    if (message.type !== 'request') return;
    const answer = reply(message);
    if (answer !== undefined)
      ws.send(JSON.stringify({ type: 'response', id: message.id, ...(answer as object) }));
  });
}

describe('ChromeBridgeServer', () => {
  let server: ChromeBridgeServer | null = null;
  const sockets: WebSocket[] = [];

  async function start(
    options: { token?: string | null; requestTimeoutMs?: number; heartbeatMs?: number } = {}
  ) {
    const token = options.token === undefined ? null : options.token;
    const created = new ChromeBridgeServer({
      getToken: () => token,
      logger,
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
    });
    server = created;
    const port = await created.listen(0);
    return { server: created, port };
  }

  async function open(port: number, options?: Parameters<typeof dial>[1]): Promise<WebSocket> {
    const outcome = await dial(port, options);
    if (outcome.kind !== 'open') throw new Error(`refused with ${outcome.status}`);
    sockets.push(outcome.ws);
    return outcome.ws;
  }

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await server?.close();
    server = null;
    vi.clearAllMocks();
  });

  it('listens on loopback only and not before listen() is called', async () => {
    const idle = new ChromeBridgeServer({ logger });
    expect(idle.listening).toBe(false);
    expect(idle.port).toBeNull();
    const { port } = await start();
    const bound = await new Promise<string>((resolve, reject) => {
      const socket = netConnect({ host: '127.0.0.1', port }, () => {
        resolve(socket.remoteAddress ?? '');
        socket.destroy();
      });
      socket.once('error', reject);
    });
    expect(bound).toBe('127.0.0.1');
  });

  it('stops listening after close()', async () => {
    const { server: running, port } = await start();
    await running.close();
    const outcome = await new Promise<string>((resolve) => {
      const socket = netConnect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve('connected');
      });
      socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
    });
    expect(outcome).toBe('ECONNREFUSED');
  });

  it('accepts a direct zero-token connection with orkestra-chrome.v1 from an extension origin', async () => {
    const { server: running, port } = await start({ token: null });
    const ws = await open(port, { token: null });
    expect(running.connected).toBe(true);
    ws.close();
    await waitClosed(ws);
    expect(running.connected).toBe(false);
  });

  it('remains backward-compatible when an optional token.<hex> subprotocol is also sent', async () => {
    const { server: running, port } = await start({ token: TOKEN });
    const ws = await open(port, { token: TOKEN });
    expect(running.connected).toBe(true);
    ws.close();
    await waitClosed(ws);

    // Eski veya farklı bir token gönderilse bile 401/403 ile reddetmez.
    const ws2 = await open(port, { token: OTHER_TOKEN });
    expect(running.connected).toBe(true);
    ws2.close();
    await waitClosed(ws2);
  });

  it('refuses a handshake missing the orkestra-chrome.v1 subprotocol with 403', async () => {
    const { port } = await start();
    expect(await dial(port, { protocols: ['other-protocol.v1'] })).toEqual({
      kind: 'refused',
      status: 403,
    });
  });

  it.each([
    ['a web page origin', 'https://evil.example'],
    ['a look-alike origin', 'chrome-extension-evil://abc'],
    ['a malformed extension id', 'chrome-extension://short'],
  ])('refuses %s', async (_name, origin) => {
    const { port } = await start();
    expect(await dial(port, { origin })).toEqual({ kind: 'refused', status: 403 });
  });

  it('refuses a missing Origin header', async () => {
    const { port } = await start();
    expect(await dial(port, { origin: null })).toEqual({ kind: 'refused', status: 403 });
  });

  it('refuses a rebinding Host header', async () => {
    const { port } = await start();
    expect(await dial(port, { headers: { Host: 'evil.example' } })).toEqual({
      kind: 'refused',
      status: 403,
    });
  });

  it('replaces an existing connection cleanly when a new extension socket connects (MV3 reconnect)', async () => {
    const { server: running, port } = await start();
    const first = await open(port);
    fakeExtension(first, () => undefined);
    const inFlightOnFirst = running.request('tabs_list', {}).catch((error: unknown) => error);
    const firstClosed = waitClosed(first);

    const second = await open(port);
    await firstClosed;
    expect(await inFlightOnFirst).toMatchObject({ code: 'connection_closed' });
    expect(running.connected).toBe(true);

    fakeExtension(second, () => ({ ok: true, result: 'from-second' }));
    await expect(running.request('tabs_list', {})).resolves.toBe('from-second');
  });

  it('waitForConnection resolves immediately when connected or as soon as an extension connects', async () => {
    const { server: running, port } = await start();
    expect(await running.waitForConnection(30)).toBe(false);

    const waiting = running.waitForConnection(2000);
    setTimeout(() => {
      void open(port);
    }, 20);
    await expect(waiting).resolves.toBe(true);
    await expect(running.waitForConnection(100)).resolves.toBe(true);
  });

  it('accepts a new connection after the first one closed', async () => {
    const { server: running, port } = await start();
    const first = await open(port);
    first.close();
    await waitClosed(first);
    await open(port);
    expect(running.connected).toBe(true);
  });

  it('answers 426 to plain HTTP requests', async () => {
    const { port } = await start();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(426);
  });

  it('fails requests with not_connected when no extension is connected', async () => {
    const { server: running } = await start();
    await expect(running.request('tabs_list', {})).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('round-trips requests and extension errors', async () => {
    const { server: running, port } = await start();
    const ws = await open(port);
    fakeExtension(ws, ({ action, params }) =>
      action === 'click'
        ? { ok: false, error: { code: 'no_such_element', message: 'Element not found' } }
        : { ok: true, result: { action, params } }
    );
    await expect(running.request('read_page', { tabId: 3 })).resolves.toEqual({
      action: 'read_page',
      params: { tabId: 3 },
    });
    const failure = await running.request('click', { tabId: 3, ref: 'ref_1' }).catch((e) => e);
    expect(failure).toBeInstanceOf(ChromeBridgeError);
    expect(failure).toMatchObject({ code: 'no_such_element', message: 'Element not found' });
  });

  it('times out when the extension does not answer', async () => {
    const { server: running, port } = await start({ requestTimeoutMs: 50 });
    const ws = await open(port);
    fakeExtension(ws, () => undefined);
    await expect(running.request('tabs_list', {})).rejects.toMatchObject({ code: 'timeout' });
  });

  it('fails pending requests when the extension disconnects', async () => {
    const { server: running, port } = await start();
    const ws = await open(port);
    fakeExtension(ws, () => undefined);
    const pending = running.request('tabs_list', {});
    ws.close();
    await expect(pending).rejects.toMatchObject({ code: 'connection_closed' });
  });

  it('disconnect() drops the extension and fails pending requests', async () => {
    const { server: running, port } = await start();
    const ws = await open(port);
    fakeExtension(ws, () => undefined);
    const pending = running.request('tabs_list', {});
    running.disconnect();
    await expect(pending).rejects.toMatchObject({ code: 'connection_closed' });
    await waitClosed(ws);
    expect(running.connected).toBe(false);
  });

  it('ignores responses it never asked for and closes on binary frames', async () => {
    const { server: running, port } = await start();
    const ws = await open(port);
    ws.send(JSON.stringify({ type: 'response', id: 'nope', ok: true, result: 1 }));
    expect(running.connected).toBe(true);
    const closed = waitClosed(ws);
    (ws as unknown as { send(data: Buffer): void }).send(Buffer.from([1, 2, 3]));
    await closed;
    expect(running.connected).toBe(false);
  });

  it('terminates an extension that stops answering heartbeats', async () => {
    const { server: running, port } = await start({ heartbeatMs: 30 });
    const ws = await open(port);
    const closed = waitClosed(ws);
    await closed;
    expect(running.connected).toBe(false);
  });
});
