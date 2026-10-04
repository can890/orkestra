import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok } from '@emdash/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '#primitives/mcp/api';
import { installMcpOAuth } from './mcp-oauth';
import { mcpOAuthBridgeSource } from './mcp-oauth-bridge';

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const input = {
  grant: {
    server_name: 'elevenlabs',
    server_url: 'https://api.us.elevenlabs.io/v1/mcp',
    issuer: 'https://api.us.elevenlabs.io',
    client_id: 'fixture-client',
    access_token: 'fixture-access',
    refresh_token: 'fixture-refresh',
    expires_at: 9000000000000,
  },
  providers: ['claude', 'codex'],
};
async function home() {
  const directory = await mkdtemp(join(tmpdir(), 'orkestra-oauth-test-'));
  temporary.push(directory);
  return directory;
}
describe('authorized MCP installation', () => {
  it('writes protected credentials outside native agent configs and preserves provider selection', async () => {
    const directory = await home();
    let server: McpServer | undefined;
    const saved = await installMcpOAuth(input, directory, async (value) => {
      server = value;
      return ok(undefined);
    });
    expect(saved.success).toBe(true);
    expect(server?.providers).toEqual(['claude', 'codex']);
    expect(JSON.stringify(server)).not.toContain('fixture-access');
    expect(JSON.stringify(server)).not.toContain('fixture-refresh');
    const credentials = server!.args![1];
    expect((await stat(credentials)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(credentials, 'utf8')).audio_only).toBe(true);
    expect(await readFile(server!.args![0], 'utf8')).toBe(mcpOAuthBridgeSource);
  });
  it('installs a Google account as a protected stdio connector on the selected host', async () => {
    const directory = await home();
    let server: McpServer | undefined;
    const grant = {
      server_name: 'google_drive',
      server_url: 'https://www.googleapis.com/',
      client_id: 'fixture.apps.googleusercontent.com',
      access_token: 'fixture-google-access',
      refresh_token: 'fixture-google-refresh',
      expires_at: Date.now() + 3600000,
      scopes: ['https://www.googleapis.com/auth/drive'],
      google_workspace: {
        tool: 'drive' as const,
        email: 'fixture@example.com',
        client_secret: 'fixture-google-secret',
      },
    };
    const result = await installMcpOAuth(
      { grant, providers: ['claude', 'grok'] },
      directory,
      async (value) => {
        server = value;
        return ok(undefined);
      }
    );
    expect(result.success).toBe(true);
    expect(server?.providers).toEqual(['claude', 'grok']);
    expect(JSON.stringify(server)).not.toContain('fixture-google-secret');
    expect(JSON.stringify(server)).not.toContain('fixture-google-access');
    const session = server!.args![1];
    expect((await stat(session)).mode & 0o777).toBe(0o600);
    const credentialPath = join(
      session.replace(/\/session.json$/, ''),
      'google-credentials',
      'fixture@example.com.json'
    );
    const credential = JSON.parse(await readFile(credentialPath, 'utf8'));
    expect(credential.token).toBe('fixture-google-access');
    expect(credential.refresh_token).toBe('fixture-google-refresh');
    expect(credential.token_uri).toBe('https://oauth2.googleapis.com/token');
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(server!.args![0], 'utf8')).toContain('workspace-mcp==2.0.0');
    const save = vi.fn();
    expect(
      (
        await installMcpOAuth(
          { grant: { ...grant, server_name: 'elevenlabs' }, providers: ['claude'] },
          directory,
          save
        )
      ).success
    ).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
  it('rejects traversal names and insecure endpoints before writing anything', async () => {
    const directory = await home();
    const save = vi.fn();
    expect(
      (
        await installMcpOAuth(
          { ...input, grant: { ...input.grant, server_name: '../../wrong' } },
          directory,
          save
        )
      ).success
    ).toBe(false);
    expect(
      (
        await installMcpOAuth(
          { ...input, grant: { ...input.grant, server_url: 'http://unsafe.example' } },
          directory,
          save
        )
      ).success
    ).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
  it('does not report success when native agent configuration fails', async () => {
    const directory = await home();
    const result = await installMcpOAuth(input, directory, async () =>
      err({ type: 'io', message: 'fixture failure' })
    );
    expect(result.success).toBe(false);
  });
  it('relays real MCP messages, filters ElevenLabs tools and refreshes expired access tokens', async () => {
    const directory = await home();
    const bridge = join(directory, 'bridge.mjs');
    const credentials = join(directory, 'session.json');
    await writeFile(bridge, mcpOAuthBridgeSource);
    await writeFile(
      credentials,
      JSON.stringify({ ...input.grant, audio_only: true, expires_at: 1 })
    );
    const fixture = join(directory, 'fixture.mjs');
    await writeFile(
      fixture,
      `globalThis.fetch = async (url, options = {}) => {
      if (String(url).includes('.well-known')) return Response.json({issuer:'https://api.us.elevenlabs.io', token_endpoint:'https://api.us.elevenlabs.io/v1/oauth/token'});
      if (String(url).includes('/oauth/token')) return Response.json({access_token:'fixture-renewed',refresh_token:'fixture-rotated',expires_in:3600});
      if (options.headers.Authorization !== 'Bearer fixture-renewed') throw new Error('stale token');
      const request = JSON.parse(options.body);
      if (request.method === 'initialize') return Response.json({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}}, {headers:{'Mcp-Session-Id':'fixture-session'}});
      if (request.method === 'tools/list') return new Response('data: '+JSON.stringify({jsonrpc:'2.0',id:request.id,result:{tools:[{name:'creative_generate_speech'},{name:'creative_generate_video'}]}})+'\\n\\n',{headers:{'Content-Type':'text/event-stream'}});
      if (request.method === 'tools/call') return Response.json({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:'audio-fixture'}]}});
      return new Response(null,{status:202});
    }; await import('./bridge.mjs');`
    );
    const child = spawn(process.execPath, [fixture, credentials], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    const messages = () =>
      output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    try {
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n'
      );
      await vi.waitFor(() => expect(messages().some((value) => value.id === 1)).toBe(true));
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
      );
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'creative_generate_video', arguments: {} },
        }) + '\n'
      );
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'creative_generate_speech', arguments: {} },
        }) + '\n'
      );
      await vi.waitFor(() => expect(messages()).toHaveLength(4));
      expect(messages().find((value) => value.id === 2).result.tools).toEqual([
        { name: 'creative_generate_speech' },
      ]);
      expect(messages().find((value) => value.id === 3).error.message).toContain('yalnızca ses');
      expect(messages().find((value) => value.id === 4).result.content[0].text).toBe(
        'audio-fixture'
      );
      const grant = JSON.parse(await readFile(credentials, 'utf8'));
      expect(grant.refresh_token).toBe('fixture-rotated');
      expect(grant.expires_at).toBeGreaterThan(Date.now());
      expect(output).not.toContain('fixture-renewed');
    } finally {
      child.kill();
    }
  });
});
