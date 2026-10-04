export const googleWorkspaceBridgeSource = String.raw`
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const client = config.google_workspace;
if (!client || !/^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(client.email)) throw new Error('Google hesabı doğrulanamadı.');
const child = spawn('uvx', ['workspace-mcp==2.0.0', '--transport', 'stdio', '--tools', client.tool], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PATH: [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? ''].join(delimiter),
    GOOGLE_OAUTH_CLIENT_ID: config.client_id,
    GOOGLE_OAUTH_CLIENT_SECRET: client.client_secret,
    USER_GOOGLE_EMAIL: client.email,
    WORKSPACE_MCP_CREDENTIALS_DIR: join(dirname(process.argv[2]), 'google-credentials'),
    GOOGLE_MCP_CREDENTIALS_DIR: join(dirname(process.argv[2]), 'google-credentials'),
  },
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
// Google bağlayıcısının çıktısı kullanıcıya veya uygulama günlüklerine hesap bilgisi sızdırmaz.
child.stderr.resume();
child.once('error', () => { process.stderr.write('Google araçları başlatılamadı. Bu makinede uv kurulmalı.\n'); process.exitCode = 1; process.stdin.destroy(); });
child.once('exit', code => { process.exitCode = code ?? 1; process.stdin.destroy(); });
process.once('SIGTERM', () => child.kill('SIGTERM'));
process.once('SIGINT', () => child.kill('SIGINT'));
process.stdin.once('end', () => child.stdin.end());
`;
