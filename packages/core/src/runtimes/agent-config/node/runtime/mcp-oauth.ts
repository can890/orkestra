import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { err, type Result } from '@orkestra/shared';
import type { McpServer } from '#primitives/mcp/api';
import type { AgentConfigMcpError } from '#runtimes/agent-config/api';
import { installMcpOAuthInputSchema, type InstallMcpOAuthInput } from '../../api/mcp-oauth';
import { googleWorkspaceBridgeSource } from './google-workspace-bridge';
import { mcpOAuthBridgeSource } from './mcp-oauth-bridge';

export async function installMcpOAuth(
  input: InstallMcpOAuthInput,
  home: string,
  save: (server: McpServer) => Promise<Result<void, AgentConfigMcpError>>
): Promise<Result<void, AgentConfigMcpError>> {
  const parsed = installMcpOAuthInputSchema.safeParse(input);
  if (!parsed.success)
    return err({ type: 'invalid-state', message: 'Hesap bağlantısı doğrulanamadı.' });
  let directory: string | undefined;
  try {
    const root = join(home, '.local', 'share', 'orkestra', 'connections');
    await mkdir(root, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(root, parsed.data.grant.server_name + '-'));
    const credentials = join(directory, 'session.json');
    const bridge = join(directory, 'bridge.mjs');
    const audioOnly = new URL(parsed.data.grant.server_url).hostname.endsWith('.elevenlabs.io');
    await writeFile(credentials, JSON.stringify({ ...parsed.data.grant, audio_only: audioOnly }), {
      mode: 0o600,
    });
    const google = parsed.data.grant.google_workspace;
    if (google) {
      const googleDirectory = join(directory, 'google-credentials');
      await mkdir(googleDirectory, { mode: 0o700 });
      await writeFile(
        join(googleDirectory, encodeURIComponent(google.email).replace(/%40/g, '@') + '.json'),
        JSON.stringify({
          token: parsed.data.grant.access_token,
          refresh_token: parsed.data.grant.refresh_token,
          token_uri: 'https://oauth2.googleapis.com/token',
          client_id: parsed.data.grant.client_id,
          client_secret: google.client_secret,
          scopes: parsed.data.grant.scopes,
          expiry: parsed.data.grant.expires_at
            ? new Date(parsed.data.grant.expires_at).toISOString()
            : null,
        }),
        { mode: 0o600 }
      );
    }
    await writeFile(bridge, google ? googleWorkspaceBridgeSource : mcpOAuthBridgeSource, {
      mode: 0o600,
    });
    const saved = await save({
      name: parsed.data.grant.server_name,
      transport: 'stdio',
      command: process.execPath,
      args: [bridge, credentials],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      providers: parsed.data.providers,
      enabled: true,
      timeout: 180,
    });
    if (!saved.success) await rm(directory, { recursive: true, force: true });
    return saved;
  } catch {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    return err({ type: 'io', message: 'Hesap bağlantısı makineye kaydedilemedi.' });
  }
}
