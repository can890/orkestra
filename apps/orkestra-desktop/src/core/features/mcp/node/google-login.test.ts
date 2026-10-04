import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { googleScopes, googleTool, loginGoogle, readGoogleClient } from './google-login';
const client = { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-secret' };
describe('Google account login', () => {
  it('restricts service selection and requests only its service permissions', () => {
    expect(googleTool('google_drive')).toBe('drive');
    expect(googleTool('drive')).toBeUndefined();
    expect(googleTool('google_unknown')).toBeUndefined();
    expect(googleScopes('drive')).not.toContain('https://www.googleapis.com/auth/gmail.modify');
  });
  it('loads a desktop client registration and rejects malformed registration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orkestra-google-test-'));
    const path = join(directory, 'client.json');
    try {
      await writeFile(
        path,
        JSON.stringify({
          installed: {
            client_id: client.clientId,
            client_secret: client.clientSecret,
            auth_uri: 'https://accounts.google.com/o/oauth2/auth',
            token_uri: 'https://oauth2.googleapis.com/token',
          },
        })
      );
      expect(await readGoogleClient(path)).toEqual(client);
      await writeFile(path, JSON.stringify({ web: {} }));
      await expect(readGoogleClient(path)).rejects.toThrow('google-client-missing');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('validates loopback state and PKCE and verifies Google identity before accepting credentials', async () => {
    let authorization!: URL;
    let onReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      onReady = resolve;
    });
    const fetcher = vi.fn(async (url, options) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        const body = options!.body as URLSearchParams;
        expect(body.get('code')).toBe('fixture-code');
        expect(body.get('client_secret')).toBe(client.clientSecret);
        expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(
          authorization.searchParams.get('code_challenge')
        );
        return Response.json({
          access_token: 'fixture-access',
          refresh_token: 'fixture-refresh',
          expires_in: 3600,
          scope: googleScopes('drive').join(' '),
        });
      }
      expect(url).toBe('https://www.googleapis.com/oauth2/v2/userinfo');
      return Response.json({ email: 'fixture@example.com', verified_email: true });
    }) as unknown as typeof fetch;
    const login = loginGoogle({
      name: 'google_drive',
      tool: 'drive',
      client,
      signal: new AbortController().signal,
      fetcher,
      onUrl: (url) => {
        authorization = new URL(url);
        onReady();
      },
    });
    await ready;
    expect(authorization.origin).toBe('https://accounts.google.com');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.href).not.toContain(client.clientSecret);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ state: 'wrong', code: 'untrusted-code' }).toString();
    expect((await fetch(callback)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    callback.searchParams.set('code', 'fixture-code');
    expect((await fetch(callback)).status).toBe(200);
    expect(await login).toMatchObject({
      server_name: 'google_drive',
      google_workspace: { tool: 'drive', email: 'fixture@example.com' },
    });
  });
  it('cancels without issuing tokens or leaving the callback open', async () => {
    const abort = new AbortController();
    let onReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      onReady = resolve;
    });
    const fetcher = vi.fn();
    const login = loginGoogle({
      name: 'google_drive',
      tool: 'drive',
      client,
      signal: abort.signal,
      fetcher,
      onUrl: () => onReady(),
    });
    const result = expect(login).rejects.toThrow('google-cancelled');
    await ready;
    abort.abort();
    await result;
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects incomplete Google permissions before reading account identity', async () => {
    let url!: URL;
    let onReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      onReady = resolve;
    });
    const fetcher = vi.fn(async () =>
      Response.json({
        access_token: 'fixture-access',
        refresh_token: 'fixture-refresh',
        scope: 'openid',
      })
    ) as unknown as typeof fetch;
    const login = loginGoogle({
      name: 'google_drive',
      tool: 'drive',
      client,
      signal: new AbortController().signal,
      fetcher,
      onUrl: (value) => {
        url = new URL(value);
        onReady();
      },
    });
    const result = expect(login).rejects.toThrow('google-scopes-missing');
    await ready;
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({
      state: url.searchParams.get('state')!,
      code: 'fixture-code',
    }).toString();
    await fetch(callback);
    await result;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
