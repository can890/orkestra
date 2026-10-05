import { hostRef, LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { err, ok } from '@orkestra/shared';
import { describe, expect, it, vi } from 'vitest';
import type {
  ManualPreviewServerRequest,
  PreviewServer,
} from '@core/primitives/preview-servers/api';
import {
  LoopbackForwarder,
  type BrowserToolScope,
  type LoopbackForwardBackend,
} from './loopback-forwarding';

const remoteScope: BrowserToolScope = {
  conversationId: 'chat-1',
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  taskId: 'task-1',
  host: hostRef('remote', 'conn-1'),
};
const localScope: BrowserToolScope = { ...remoteScope, host: LOCAL_HOST_REF };

/** Önizleme yönlendirmelerinin bellekteki karşılığı; her yeni port bir sonraki yerel portu alır. */
function createBackend(initial: PreviewServer[] = []) {
  const servers = [...initial];
  const requests: ManualPreviewServerRequest[] = [];
  let nextLocalPort = 41_000;
  const backend: LoopbackForwardBackend = {
    listForWorkspace: vi.fn(async ({ projectId, workspaceId }) =>
      ok(
        servers.filter(
          (server) => server.projectId === projectId && server.workspaceId === workspaceId
        )
      )
    ),
    forwardManual: vi.fn(async (request: ManualPreviewServerRequest) => {
      requests.push(request);
      // Gerçek tünel gibi eşzamanlı istekler bir sonraki olay döngüsünde tamamlanır.
      await new Promise((resolve) => setTimeout(resolve, 5));
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
        localPort: nextLocalPort++,
      };
      servers.push(server);
      return ok(server);
    }),
  };
  return { backend, servers, requests };
}

function forwarded(
  remotePort: number,
  localPort: number | undefined,
  status = 'ready'
): PreviewServer {
  return {
    id: `auto:${remotePort}`,
    kind: 'forwarded',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    source: { kind: 'terminal-output', terminalId: 'terminal-1' },
    protocol: 'http:',
    urlPath: '/',
    status: status === 'failed' ? { kind: 'failed', message: 'x' } : { kind: 'ready' },
    connectionId: 'conn-1',
    remotePort,
    ...(localPort !== undefined ? { localPort } : {}),
  };
}

describe('LoopbackForwarder', () => {
  it('opens loopback URLs unchanged for local conversations', async () => {
    const { backend } = createBackend();
    const forwarder = new LoopbackForwarder(backend);
    await expect(forwarder.resolve('localhost:3000/app', localScope)).resolves.toEqual({
      url: 'http://localhost:3000/app',
    });
    await expect(forwarder.resolve('http://0.0.0.0:8080', localScope)).resolves.toEqual({
      url: 'http://0.0.0.0:8080/',
    });
    expect(backend.forwardManual).not.toHaveBeenCalled();
    await expect(forwarder.describe('http://127.0.0.1:3000/', localScope)).resolves.toBe(
      'http://127.0.0.1:3000/'
    );
  });

  it('forwards remote loopback ports and keeps path, query and hash', async () => {
    const { backend, requests } = createBackend();
    const forwarder = new LoopbackForwarder(backend);
    await expect(
      forwarder.resolve('http://localhost:3000/app/page?tab=2#top', remoteScope)
    ).resolves.toEqual({
      url: 'http://127.0.0.1:41000/app/page?tab=2#top',
      forward: { remotePort: 3000, localPort: 41_000 },
    });
    expect(requests).toEqual([
      {
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        connectionId: 'conn-1',
        protocol: 'http:',
        remotePort: 3000,
      },
    ]);
    // Aynı uzak port yeniden yönlendirilmez; 127.0.0.1 ve 0.0.0.0 da uzak makineyi gösterir.
    await expect(forwarder.resolve('0.0.0.0:3000/other', remoteScope)).resolves.toMatchObject({
      url: 'http://127.0.0.1:41000/other',
    });
    expect(requests).toHaveLength(1);
    await expect(forwarder.describe('http://127.0.0.1:41000/x', remoteScope)).resolves.toBe(
      'http://127.0.0.1:41000/x (remote localhost:3000)'
    );
  });

  it('forwards IPv6 loopback and default https ports', async () => {
    const { backend, requests } = createBackend();
    const forwarder = new LoopbackForwarder(backend);
    await expect(forwarder.resolve('https://[::1]:8443/api', remoteScope)).resolves.toEqual({
      url: 'https://127.0.0.1:41000/api',
      forward: { remotePort: 8443, localPort: 41_000 },
    });
    await expect(forwarder.resolve('https://localhost/', remoteScope)).resolves.toMatchObject({
      url: 'https://127.0.0.1:41001/',
    });
    expect(requests.map(({ protocol, remotePort }) => [protocol, remotePort])).toEqual([
      ['https:', 8443],
      ['https:', 443],
    ]);
  });

  it('reuses existing forwards, ignores failed ones and keeps its own local addresses', async () => {
    const { backend, requests } = createBackend([
      forwarded(5173, 5173),
      forwarded(8080, undefined, 'failed'),
    ]);
    const forwarder = new LoopbackForwarder(backend);
    await expect(forwarder.resolve('localhost:5173', remoteScope)).resolves.toEqual({
      url: 'http://127.0.0.1:5173/',
      forward: { remotePort: 5173, localPort: 5173 },
    });
    await expect(forwarder.resolve('http://localhost:8080', remoteScope)).resolves.toMatchObject({
      url: 'http://127.0.0.1:41000/',
    });
    await expect(forwarder.resolve('http://127.0.0.1:41000/x', remoteScope)).resolves.toEqual({
      url: 'http://127.0.0.1:41000/x',
      forward: { remotePort: 8080, localPort: 41_000 },
    });
    expect(requests.map((request) => request.remotePort)).toEqual([8080]);
  });

  it('opens one forward for concurrent requests of the same port', async () => {
    const { backend, requests } = createBackend();
    const forwarder = new LoopbackForwarder(backend);
    const [first, second] = await Promise.all([
      forwarder.resolve('localhost:4000', remoteScope),
      forwarder.resolve('localhost:4000/b', remoteScope),
    ]);
    expect(first.url).toBe('http://127.0.0.1:41000/');
    expect(second.url).toBe('http://127.0.0.1:41000/b');
    expect(requests).toHaveLength(1);
  });

  it('leaves other hosts alone and rejects unsupported addresses', async () => {
    const { backend } = createBackend();
    const forwarder = new LoopbackForwarder(backend);
    await expect(forwarder.resolve('example.com/docs', remoteScope)).resolves.toEqual({
      url: 'https://example.com/docs',
    });
    await expect(forwarder.resolve('about:blank', remoteScope)).resolves.toEqual({
      url: 'about:blank',
    });
    await expect(forwarder.resolve('file:///etc/passwd', remoteScope)).rejects.toThrow(
      'file URLs cannot be opened'
    );
    await expect(forwarder.resolve('not a url', remoteScope)).rejects.toThrow(
      'Cannot open "not a url": it is not a valid URL'
    );
    await expect(forwarder.resolve('javascript:alert(1)', remoteScope)).rejects.toThrow(
      'only http and https URLs can be opened'
    );
    expect(backend.forwardManual).not.toHaveBeenCalled();
  });

  it('explains forwarding failures', async () => {
    const { backend } = createBackend();
    backend.forwardManual = vi.fn(async () =>
      err({ type: 'open-failed' as const, message: 'Failed to open SSH port forward' })
    );
    const forwarder = new LoopbackForwarder(backend);
    await expect(forwarder.resolve('localhost:3000', remoteScope)).rejects.toThrow(
      'Could not forward port 3000 of the workspace host over SSH: Failed to open SSH port forward'
    );
  });
});
