import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { waitFor } from '@orkestra/shared/testing';
import type { Client } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshClientProxy, SshExecResult } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import { AGENT_TOOLS_BRIDGE_SOURCE } from './agent-tools-bridge';
import { AgentToolsRemoteEndpoints } from './agent-tools-remote-endpoints';

/** ssh2 istemcisinin ters Unix soketi yönlendirmesiyle ilgili yüzeyi. */
class FakeSshClient extends EventEmitter {
  readonly forwarded: string[] = [];
  readonly unforwarded: string[] = [];
  forwardError: Error | null = null;

  openssh_forwardInStreamLocal(socketPath: string, callback: (error?: Error) => void): void {
    if (this.forwardError) {
      callback(this.forwardError);
      return;
    }
    this.forwarded.push(socketPath);
    callback();
  }

  openssh_unforwardInStreamLocal(socketPath: string, callback: () => void): void {
    this.unforwarded.push(socketPath);
    callback();
  }
}

/** Uzak uçtaki köprünün açtığı Unix soketi bağlantısını temsil eden SSH kanalı. */
class FakeChannel extends Duplex {
  readonly received: Buffer[] = [];

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.received.push(chunk);
    callback();
  }
}

type FakeProxy = {
  connectionId: string;
  isConnected: boolean;
  client: FakeSshClient;
  scripts: string[];
  prepareResult: SshExecResult;
};

function createProxy(): FakeProxy & { proxy: SshClientProxy } {
  const state: FakeProxy = {
    connectionId: 'conn-1',
    isConnected: true,
    client: new FakeSshClient(),
    scripts: [],
    prepareResult: { stdout: '', stderr: '', exitCode: 0 },
  };
  const proxy = {
    get connectionId() {
      return state.connectionId;
    },
    get isConnected() {
      return state.isConnected;
    },
    get client() {
      return state.client as unknown as Client;
    },
    execScript: async (script: string): Promise<SshExecResult> => {
      state.scripts.push(script);
      if (script === 'printf %s "$HOME"') return { stdout: '/home/dev', stderr: '', exitCode: 0 };
      return state.prepareResult;
    },
  } as unknown as SshClientProxy;
  return Object.assign(state, { proxy });
}

describe('AgentToolsRemoteEndpoints', () => {
  let echo: net.Server;
  let echoPort: number;
  let fake: ReturnType<typeof createProxy>;
  let endpoints: AgentToolsRemoteEndpoints;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  beforeEach(async () => {
    // Masaüstündeki RPC sunucusunun yerine geçen yankı sunucusu.
    echo = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.write(`echo:${chunk.toString('utf8')}`));
    });
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    echoPort = (echo.address() as net.AddressInfo).port;
    fake = createProxy();
    endpoints = new AgentToolsRemoteEndpoints({
      getProxy: (connectionId) => (connectionId === 'conn-1' ? fake.proxy : undefined),
      localRpcPort: async () => echoPort,
      nodePath: (home) => `${home}/.orkestra/workspace-server/current/node`,
      directory: '.orkestra/agent-tools',
      logger: logger as never,
      refreshIntervalMs: 20,
    });
  });

  afterEach(async () => {
    endpoints.dispose();
    await new Promise((resolve) => echo.close(resolve));
  });

  it('uploads the bridge once per connection and forwards a private socket', async () => {
    const [endpoint, again] = await Promise.all([
      endpoints.ensure('conn-1'),
      endpoints.ensure('conn-1'),
    ]);
    expect(again).toBe(endpoint);
    expect(endpoint).toEqual({
      nodePath: '/home/dev/.orkestra/workspace-server/current/node',
      scriptPath: expect.stringMatching(
        /^\/home\/dev\/\.orkestra\/agent-tools\/orkestra-mcp-bridge-[0-9a-f]{12}\.cjs$/
      ),
      socketPath: expect.stringMatching(
        /^\/home\/dev\/\.orkestra\/agent-tools\/rpc-[0-9a-f]{12}\.sock$/
      ),
    });
    expect(fake.scripts).toHaveLength(2);
    const prepare = fake.scripts[1]!;
    expect(prepare).toContain('dir=/home/dev/.orkestra/agent-tools\n');
    expect(prepare).toContain('chmod 700 "$dir"');
    expect(prepare).toContain(Buffer.from(AGENT_TOOLS_BRIDGE_SOURCE).toString('base64'));
    expect(prepare).toContain('rm -f "$socket"');
    expect(fake.client.forwarded).toEqual([endpoint.socketPath]);
    expect(await endpoints.ensure('conn-1')).toBe(endpoint);
    expect(fake.scripts).toHaveLength(2);
    expect(endpoints.activeCount()).toBe(1);
  });

  it('pipes connections on the forwarded socket to the local RPC port', async () => {
    const endpoint = await endpoints.ensure('conn-1');
    const ignored = vi.fn();
    fake.client.emit('unix connection', { socketPath: '/elsewhere.sock' }, ignored, vi.fn());
    expect(ignored).not.toHaveBeenCalled();

    const channel = new FakeChannel();
    fake.client.emit(
      'unix connection',
      { socketPath: endpoint.socketPath },
      () => channel,
      vi.fn()
    );
    channel.push(Buffer.from('ping'));
    await waitFor(() => Buffer.concat(channel.received).toString('utf8') === 'echo:ping');
    const closed = once(channel, 'close');
    channel.destroy();
    await closed;
  });

  it('re-forwards the same socket path after SSH reconnects', async () => {
    const endpoint = await endpoints.ensure('conn-1');
    const previous = fake.client;
    fake.client = new FakeSshClient();
    // Yenileme zamanlayıcısı yeni istemciyi fark edip tüneli aynı yola kurar.
    await waitFor(() => fake.client.forwarded.length === 1);
    expect(fake.client.forwarded).toEqual([endpoint.socketPath]);
    expect(previous.unforwarded).toEqual([endpoint.socketPath]);
    expect(previous.listenerCount('unix connection')).toBe(0);
    expect(fake.client.listenerCount('unix connection')).toBe(1);
    expect(await endpoints.ensure('conn-1')).toEqual(endpoint);
  });

  it('reports missing connections, runtimes and forwarding failures', async () => {
    await expect(endpoints.ensure('other')).rejects.toThrow('SSH bağlantısı yok');
    fake.prepareResult = {
      stdout: '',
      stderr: 'workspace-server Node çalışma zamanı bulunamadı',
      exitCode: 3,
    };
    await expect(endpoints.ensure('conn-1')).rejects.toThrow(
      'Uzak Orkestra köprüsü hazırlanamadı: workspace-server Node çalışma zamanı bulunamadı'
    );
    fake.prepareResult = { stdout: '', stderr: '', exitCode: 0 };
    fake.client.forwardError = new Error('administratively prohibited');
    await expect(endpoints.ensure('conn-1')).rejects.toThrow(
      'SSH ters tüneli kurulamadı: administratively prohibited'
    );
    expect(endpoints.activeCount()).toBe(0);
  });

  it('removes forwards on dispose', async () => {
    const endpoint = await endpoints.ensure('conn-1');
    endpoints.dispose();
    expect(fake.client.unforwarded).toEqual([endpoint.socketPath]);
    expect(fake.client.listenerCount('unix connection')).toBe(0);
    await expect(endpoints.ensure('conn-1')).rejects.toThrow('shutting down');
  });
});
