import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export const googleTools = [
  'gmail',
  'drive',
  'calendar',
  'docs',
  'sheets',
  'slides',
  'forms',
  'tasks',
  'chat',
] as const;
export type GoogleTool = (typeof googleTools)[number];
export function googleTool(name: string): GoogleTool | undefined {
  const tool = name.replace(/^google_/, '');
  return name.startsWith('google_') && googleTools.includes(tool as GoogleTool)
    ? (tool as GoogleTool)
    : undefined;
}
const prefix = 'https://www.googleapis.com/auth/';
const scopes: Record<GoogleTool, string[]> = {
  gmail: ['gmail.modify', 'gmail.settings.basic'],
  drive: ['drive'],
  calendar: ['calendar'],
  docs: ['documents', 'drive.readonly', 'drive.file'],
  sheets: ['spreadsheets', 'drive.readonly', 'drive.file'],
  slides: ['presentations'],
  forms: ['forms.body', 'forms.responses.readonly'],
  tasks: ['tasks'],
  chat: ['chat.messages', 'chat.spaces', 'chat.memberships.readonly', 'contacts.readonly'],
};
export function googleScopes(tool: GoogleTool) {
  return [
    'openid',
    prefix + 'userinfo.email',
    prefix + 'userinfo.profile',
    ...scopes[tool].map((scope) => prefix + scope),
  ];
}
export type GoogleClient = { clientId: string; clientSecret: string };
export async function readGoogleClient(path: string): Promise<GoogleClient> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    const client = data.installed;
    if (
      !client ||
      typeof client.client_id !== 'string' ||
      !client.client_id.endsWith('.apps.googleusercontent.com') ||
      typeof client.client_secret !== 'string' ||
      !client.client_secret ||
      client.auth_uri !== 'https://accounts.google.com/o/oauth2/auth' ||
      client.token_uri !== 'https://oauth2.googleapis.com/token'
    )
      throw new Error('invalid-client');
    return { clientId: client.client_id, clientSecret: client.client_secret };
  } catch {
    throw new Error('google-client-missing');
  }
}
export async function loginGoogle(input: {
  name: string;
  tool: GoogleTool;
  client: GoogleClient;
  signal: AbortSignal;
  onUrl: (url: string) => void;
  fetcher?: typeof fetch;
}) {
  const request = input.fetcher ?? fetch;
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(64).toString('base64url');
  let redirect = '';
  let handled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Erken iptal/listen hatasında bekleyen Promise'in reddi işlenir.
  void codePromise.catch(() => {});
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', redirect || 'http://127.0.0.1');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    if (
      req.method !== 'GET' ||
      url.pathname !== '/' ||
      url.searchParams.get('state') !== state ||
      handled
    ) {
      res.writeHead(400);
      res.end('Google giriş isteği doğrulanamadı. Orkestra’ya dönüp yeniden deneyin.');
      return;
    }
    handled = true;
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') || !code) {
      res.writeHead(400);
      res.end('Google bağlantısına izin verilmedi. Orkestra’ya dönebilirsiniz.');
      rejectCode(new Error('google-denied'));
      return;
    }
    res.end('Google onayı alındı. Bağlantı sonucunu görmek için Orkestra’ya dönün.');
    resolveCode(code);
  });
  const abort = () => {
    rejectCode(new Error('google-cancelled'));
    server.close();
    server.closeAllConnections();
  };
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    if (input.signal.aborted) throw new Error('google-cancelled');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.unref();
        resolve();
      });
    });
    if (input.signal.aborted) throw new Error('google-cancelled');
    redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const requestedScopes = googleScopes(input.tool);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: input.client.clientId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: requestedScopes.join(' '),
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent select_account',
    }).toString();
    input.onUrl(url.href);
    const code = await codePromise;
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30000)]);
    const response = await request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: input.client.clientId,
        client_secret: input.client.clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
        grant_type: 'authorization_code',
      }),
    });
    if (!response.ok) throw new Error('google-token-failed');
    const token = await response.json();
    if (
      typeof token.access_token !== 'string' ||
      !token.access_token ||
      typeof token.refresh_token !== 'string' ||
      !token.refresh_token ||
      typeof token.scope !== 'string'
    )
      throw new Error('google-token-failed');
    const grantedScopes = token.scope.split(/\s+/);
    if (!requestedScopes.every((scope) => grantedScopes.includes(scope)))
      throw new Error('google-scopes-missing');
    const profileResponse = await request('https://www.googleapis.com/oauth2/v2/userinfo', {
      redirect: 'error',
      signal,
      headers: { Authorization: 'Bearer ' + token.access_token },
    });
    if (!profileResponse.ok) throw new Error('google-profile-failed');
    const profile = await profileResponse.json();
    if (
      profile.verified_email !== true ||
      typeof profile.email !== 'string' ||
      !/^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(profile.email)
    )
      throw new Error('google-profile-failed');
    return {
      server_name: input.name,
      server_url: 'https://www.googleapis.com/',
      client_id: input.client.clientId,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at:
        Date.now() + (typeof token.expires_in === 'number' ? token.expires_in : 3600) * 1000,
      scopes: grantedScopes,
      google_workspace: {
        tool: input.tool,
        email: profile.email,
        client_secret: input.client.clientSecret,
      },
    };
  } finally {
    input.signal.removeEventListener('abort', abort);
    server.close();
    server.closeAllConnections();
  }
}
