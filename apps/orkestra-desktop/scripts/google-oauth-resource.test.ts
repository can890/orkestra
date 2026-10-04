import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { googleOAuthResource } from './google-oauth-resource.ts';

const dirs: string[] = [];
const client = {
  installed: {
    client_id: 'fixture.apps.googleusercontent.com',
    client_secret: 'fixture',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    redirect_uris: ['http://localhost'],
  },
};
function file(value: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'orkestra-google-package-'));
  dirs.push(dir);
  const path = join(dir, 'client.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});
describe('Google OAuth dağıtımı', () => {
  it('uygulama kaydını kaynak yolundan Resources altına ekler', () => {
    const path = file(client);
    expect(googleOAuthResource({ ORKESTRA_GOOGLE_OAUTH_CLIENT_FILE: path })).toEqual([
      { from: path, to: 'oauth/google-client.json' },
    ]);
  });
  it('Google zorunlu dağıtımda eksik kaydı reddeder', () => {
    expect(() => googleOAuthResource({ ORKESTRA_REQUIRE_GOOGLE_OAUTH: '1' })).toThrow();
    expect(googleOAuthResource({})).toEqual([]);
  });
  it('hesap tokenlarını ve web istemcisini paketlemez', () => {
    for (const value of [
      { ...client, access_token: 'private-token' },
      { installed: { ...client.installed, refresh_token: 'private-token' } },
      { web: client.installed },
    ]) {
      expect(() =>
        googleOAuthResource({ ORKESTRA_GOOGLE_OAUTH_CLIENT_FILE: file(value) })
      ).toThrow();
    }
  });
});
