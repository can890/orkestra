import { EventEmitter } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { hostRef } from '@emdash/core/primitives/host/api';
import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import { authorizationUrl, McpConnectionManager, readLoginGrant } from './connection-manager';

const url = 'https://api.us.elevenlabs.io/v1/mcp';
const loginUrl =
  'https://elevenlabs.io/app/oauth/authorize?client_id=real-cli&response_type=code&state=fixture-state';
const input = {
  host: hostRef('remote', 'huawei'),
  server: { name: 'elevenlabs', transport: 'http' as const, url, providers: ['claude', 'codex'] },
};
function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    exitCode: null,
    kill: vi.fn(),
  });
}
describe('MCP account connection', () => {
  it('routes a Google card through account approval and installs credentials on the selected remote host', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orkestra-google-manager-'));
    const clientPath = join(directory, 'client.json');
    const originalFetch = globalThis.fetch;
    const oldClientPath = process.env.ORKESTRA_GOOGLE_OAUTH_CLIENT_FILE;
    await writeFile(
      clientPath,
      JSON.stringify({
        installed: {
          client_id: 'fixture.apps.googleusercontent.com',
          client_secret: 'fixture-secret',
          auth_uri: 'https://accounts.google.com/o/oauth2/auth',
          token_uri: 'https://oauth2.googleapis.com/token',
        },
      })
    );
    process.env.ORKESTRA_GOOGLE_OAUTH_CLIENT_FILE = clientPath;
    let authorize!: URL;
    const save = vi.fn(async () => ok(undefined));
    const resolveHost = vi.fn(async () => ok({ agentConfig: { installMcpOAuth: save } }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url).includes('/token'))
          return Response.json({
            access_token: 'fixture-access',
            refresh_token: 'fixture-refresh',
            scope: authorize.searchParams.get('scope'),
            expires_in: 3600,
          });
        return Response.json({ email: 'fixture@example.com', verified_email: true });
      })
    );
    try {
      const manager = new McpConnectionManager({ client: resolveHost } as never, {
        openUrl: async (value) => {
          authorize = new URL(value);
        },
      });
      const started = manager.start({
        host: input.host,
        server: { name: 'google_drive', transport: 'stdio', providers: ['grok', 'claude'] },
      });
      if (!started.success) throw new Error('start');
      await vi.waitFor(() => expect(authorize?.hostname).toBe('accounts.google.com'));
      expect(manager.status(started.data.id).phase).toBe('awaiting-authorization');
      expect(save).not.toHaveBeenCalled();
      const callback = new URL(authorize.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({
        code: 'fixture-code',
        state: authorize.searchParams.get('state')!,
      }).toString();
      await originalFetch(callback);
      await vi.waitFor(() => expect(manager.status(started.data.id).phase).toBe('connected'));
      expect(resolveHost).toHaveBeenCalledWith(input.host);
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          providers: ['grok', 'claude'],
          grant: expect.objectContaining({ server_name: 'google_drive' }),
        })
      );
      expect(JSON.stringify(manager.status(started.data.id))).not.toContain('fixture-access');
    } finally {
      vi.unstubAllGlobals();
      if (oldClientPath === undefined) delete process.env.ORKESTRA_GOOGLE_OAUTH_CLIENT_FILE;
      else process.env.ORKESTRA_GOOGLE_OAUTH_CLIENT_FILE = oldClientPath;
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('checks public MCP endpoints before saving, without opening an account login', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { serverInfo: { name: 'fixture' }, protocolVersion: '2025-03-26' },
      })
    );
    vi.stubGlobal('fetch', fetcher);
    const save = vi.fn(async () => ok(undefined));
    const spawnLogin = vi.fn();
    const manager = new McpConnectionManager(
      { client: async () => ok({ agentConfig: { saveMcpServer: save } }) } as never,
      { spawnLogin: spawnLogin as never }
    );
    try {
      const started = manager.start({
        ...input,
        server: { ...input.server, name: 'public_docs', oauth: false },
      });
      if (!started.success) throw new Error('start');
      await vi.waitFor(() => expect(manager.status(started.data.id).phase).toBe('connected'));
      expect(fetcher).toHaveBeenCalled();
      expect(save).toHaveBeenCalled();
      expect(spawnLogin).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('does not treat a normal website response as a connected service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })
      )
    );
    const save = vi.fn();
    const manager = new McpConnectionManager({
      client: async () => ok({ agentConfig: { saveMcpServer: save } }),
    } as never);
    try {
      const started = manager.start({
        ...input,
        server: { ...input.server, name: 'public_docs', oauth: false },
      });
      if (!started.success) throw new Error('start');
      await vi.waitFor(() => expect(manager.status(started.data.id).phase).toBe('failed'));
      expect(save).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('only accepts an OAuth authorization URL, not documentation or arbitrary output', () => {
    expect(authorizationUrl('Docs: https://docs.example.com')).toBeUndefined();
    expect(
      authorizationUrl('http://example.com/?response_type=code&client_id=a&state=b')
    ).toBeUndefined();
    expect(authorizationUrl(loginUrl.slice(0, loginUrl.indexOf('&state=')))).toBeUndefined();
    expect(authorizationUrl('\x1b[32m' + loginUrl + '\x1b[0m')).toBe(loginUrl);
  });
  it('binds the returned credential to the exact server and endpoint', () => {
    const grant = {
      server_name: 'elevenlabs',
      server_url: url,
      client_id: 'real-cli',
      access_token: 'fixture-access',
      refresh_token: 'fixture-refresh',
      expires_at: 9000000000000,
      scopes: ['text_to_speech'],
    };
    expect(readLoginGrant({ key: grant }, 'elevenlabs', url)).toMatchObject(grant);
    expect(() => readLoginGrant({ key: grant }, 'other', url)).toThrow();
    expect(() => readLoginGrant({ key: grant }, 'elevenlabs', 'https://other.example')).toThrow();
  });
  it('opens official login automatically, waits for approval, saves to the selected host and deletes temporary credentials', async () => {
    const process = child();
    const save = vi.fn(async () => ok(undefined));
    const resolve = vi.fn(async () => ok({ agentConfig: { installMcpOAuth: save } }));
    let directory = '';
    const spawnLogin = vi.fn((_cli, args, options) => {
      directory = options.env.CODEX_HOME;
      expect(args).toContain('mcp_oauth_credentials_store="file"');
      expect(args).toContain('text_to_speech,speech_history_read,flows');
      return process;
    });
    const openUrl = vi.fn(async () => {});
    const manager = new McpConnectionManager({ client: resolve } as never, {
      resolveCli: async () => '/fixture/codex',
      spawnLogin: spawnLogin as never,
      openUrl,
    });
    const started = manager.start(input);
    expect(started.success).toBe(true);
    if (!started.success) return;
    await vi.waitFor(() => expect(spawnLogin).toHaveBeenCalled());
    process.stdout.write(loginUrl + '\n');
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith(loginUrl));
    expect(save).not.toHaveBeenCalled();
    expect(manager.status(started.data.id).phase).toBe('awaiting-authorization');
    await writeFile(
      join(directory, '.credentials.json'),
      JSON.stringify({
        fixture: {
          server_name: 'elevenlabs',
          server_url: url,
          client_id: 'real-cli',
          access_token: 'fixture-access',
          expires_at: null,
        },
      })
    );
    process.emit('close', 0);
    await vi.waitFor(() => expect(manager.status(started.data.id).phase).toBe('connected'));
    expect(resolve).toHaveBeenCalledWith(input.host);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ providers: ['claude', 'codex'] }));
    expect(JSON.stringify(manager.status(started.data.id))).not.toContain('fixture-access');
    await vi.waitFor(async () => {
      await expect(access(directory)).rejects.toThrow();
    });
  });
  it('cancelling kills login and cannot save a late approval', async () => {
    const process = child();
    const save = vi.fn(async () => ok(undefined));
    const spawnLogin = vi.fn(() => process);
    const manager = new McpConnectionManager(
      { client: async () => ok({ agentConfig: { installMcpOAuth: save } }) } as never,
      { resolveCli: async () => '/fixture/codex', spawnLogin: spawnLogin as never }
    );
    const started = manager.start(input);
    if (!started.success) throw new Error('start');
    await vi.waitFor(() => expect(spawnLogin).toHaveBeenCalled());
    await manager.cancel(started.data.id);
    process.emit('close', 0);
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    expect(manager.status(started.data.id).phase).toBe('cancelled');
    expect(save).not.toHaveBeenCalled();
  });
  it('returns a Turkish error without leaking raw CLI output or credentials', async () => {
    const process = child();
    const spawnLogin = vi.fn(() => process);
    const manager = new McpConnectionManager(
      { client: async () => ok({ agentConfig: {} }) } as never,
      { resolveCli: async () => '/fixture/codex', spawnLogin: spawnLogin as never }
    );
    const started = manager.start(input);
    if (!started.success) throw new Error('start');
    await vi.waitFor(() => expect(spawnLogin).toHaveBeenCalled());
    process.stderr.write('English failure fixture-secret-token');
    process.emit('close', 1);
    await vi.waitFor(() => expect(manager.status(started.data.id).phase).toBe('failed'));
    expect(manager.status(started.data.id).message).toContain('Hesap bağlantısı');
    expect(JSON.stringify(manager.status(started.data.id))).not.toContain('fixture-secret');
  });
  it('does not call login or change native config for an unavailable host', async () => {
    const spawnLogin = vi.fn();
    const manager = new McpConnectionManager(
      {
        client: async () => err({ type: 'not-configured', host: input.host, message: 'fixture' }),
      } as never,
      { spawnLogin: spawnLogin as never }
    );
    const started = manager.start(input);
    if (!started.success) throw new Error('start');
    await vi.waitFor(() => expect(manager.status(started.data.id).phase).toBe('failed'));
    expect(spawnLogin).not.toHaveBeenCalled();
    expect(manager.status(started.data.id).message).toContain('makineye ulaşılamadı');
  });
});
