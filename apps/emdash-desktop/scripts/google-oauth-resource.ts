import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function googleOAuthResource(env: Record<string, string | undefined>) {
  const path = env.ORKESTRA_GOOGLE_OAUTH_CLIENT_FILE;
  if (!path) {
    if (env.ORKESTRA_REQUIRE_GOOGLE_OAUTH === '1') {
      throw new Error('Google bağlantılı dağıtım için ORKESTRA_GOOGLE_OAUTH_CLIENT_FILE gerekli.');
    }
    return [];
  }
  const source = resolve(path);
  const data = JSON.parse(readFileSync(source, 'utf8'));
  const client = data.installed;
  const allowed = new Set([
    'client_id',
    'project_id',
    'auth_uri',
    'token_uri',
    'auth_provider_x509_cert_url',
    'client_secret',
    'redirect_uris',
  ]);
  if (
    Object.keys(data).some((key) => key !== 'installed') ||
    !client ||
    typeof client !== 'object' ||
    Array.isArray(client) ||
    Object.keys(client).some((key) => !allowed.has(key)) ||
    typeof client.client_id !== 'string' ||
    !client.client_id.endsWith('.apps.googleusercontent.com') ||
    typeof client.client_secret !== 'string' ||
    !client.client_secret ||
    client.auth_uri !== 'https://accounts.google.com/o/oauth2/auth' ||
    client.token_uri !== 'https://oauth2.googleapis.com/token' ||
    (client.redirect_uris !== undefined &&
      (!Array.isArray(client.redirect_uris) ||
        client.redirect_uris.some((uri: unknown) => typeof uri !== 'string')))
  ) {
    throw new Error(
      'Yalnızca Google Desktop OAuth istemci kaydı paketlenebilir; hesap oturumu veya token dosyası eklenemez.'
    );
  }
  return [{ from: source, to: 'oauth/google-client.json' }];
}
