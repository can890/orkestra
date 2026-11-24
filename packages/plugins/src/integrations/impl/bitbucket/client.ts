// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/source-control-bitbucket/src/server/BitbucketApi.ts
import { err, ok, type Result } from '@orkestra/shared';
import { parseCredentials } from '../../helpers/credentials';
import {
  basicAuthorization,
  bearerAuthorization,
  createHttpClient,
  type FetchLike,
  type HttpClient,
  type HttpClientError,
  type HttpRequest,
  isHeaderSafe,
} from '../../helpers/http-client';
import type { IntegrationCredentials } from '../../host';
import type { IntegrationError } from '../../types';
import { BITBUCKET_CLOUD_HOST, BITBUCKET_CLOUD_WEB_URL } from './remote';
import {
  type BitbucketCredentials,
  bitbucketCredentialsSchema,
  bitbucketPageSchema,
  bitbucketUserSchema,
  type BitbucketVerifiedConnection,
} from './types';

export const BITBUCKET_API_BASE_URL = 'https://api.bitbucket.org/2.0';

/** Bir listeleme en fazla bu kadar sayfa izler; sınırsız `next` zincirine karşı korur. */
const MAX_PAGES = 10;

export type BitbucketClientOptions = {
  fetch?: FetchLike;
  baseUrl?: string;
};

export function readBitbucketCredentials(
  credentials: IntegrationCredentials
): Result<BitbucketCredentials, IntegrationError> {
  return parseCredentials(bitbucketCredentialsSchema, credentials);
}

/** E-posta varsa Basic (e-posta + API token), yoksa Bearer (erişim anahtarı). */
export function bitbucketAuthorization(
  credentials: BitbucketCredentials
): Result<string, IntegrationError> {
  const invalid = err<IntegrationError>({
    type: 'invalid_input',
    message: 'Bitbucket credentials contain unsupported characters.',
  });
  if (!isHeaderSafe(credentials.apiToken)) return invalid;
  if (credentials.email) {
    if (!isHeaderSafe(credentials.email)) return invalid;
    return ok(basicAuthorization(credentials.email, credentials.apiToken));
  }
  return ok(bearerAuthorization(credentials.apiToken));
}

export function createBitbucketClient(
  credentials: BitbucketCredentials,
  options: BitbucketClientOptions = {}
): Result<HttpClient, IntegrationError> {
  const authorization = bitbucketAuthorization(credentials);
  if (!authorization.success) return authorization;
  return ok(
    createHttpClient({
      provider: 'Bitbucket',
      baseUrl: options.baseUrl ?? BITBUCKET_API_BASE_URL,
      authorization: authorization.data,
      fetch: options.fetch,
    })
  );
}

/**
 * Bitbucket'ın `{ values, next }` sayfalarını `limit` dolana kadar izler. `next` mutlak bir
 * adrestir; istemci yalnızca API kökenindeki adreslere kimlik bilgisi gönderir.
 */
export async function listBitbucketPages(
  client: HttpClient,
  request: HttpRequest,
  limit: number,
  maxPages = MAX_PAGES
): Promise<Result<unknown[], HttpClientError>> {
  const values: unknown[] = [];
  let next: HttpRequest | null = request;
  let pages = 0;
  while (next && values.length < limit && pages < maxPages) {
    const response = await client.request(next);
    if (!response.success) return response;
    const page = bitbucketPageSchema.safeParse(response.data.body);
    if (!page.success) {
      return err({ type: 'generic', message: 'Bitbucket returned an unexpected page.' });
    }
    values.push(...page.data.values);
    next = page.data.next ? { path: page.data.next } : null;
    pages += 1;
  }
  return ok(values.slice(0, limit));
}

export async function verifyBitbucketCredentials(
  rawCredentials: IntegrationCredentials,
  options: BitbucketClientOptions = {}
): Promise<Result<BitbucketVerifiedConnection, IntegrationError>> {
  const credentials = readBitbucketCredentials(rawCredentials);
  if (!credentials.success) return err(credentials.error);
  const client = createBitbucketClient(credentials.data, options);
  if (!client.success) return err(client.error);

  const response = await client.data.request({ path: '/user' });
  if (!response.success) {
    // Depo/proje/çalışma alanı erişim anahtarları bir hesaba bağlı değildir; `/user` 403 döner.
    // Anahtar geçerlidir ama kimlik yoktur — hesabı masaüstü yerel kimlikle saklar.
    if (!credentials.data.email && response.error.status === 403) {
      return ok({
        displayName: 'Bitbucket access token',
        displayDetail: BITBUCKET_CLOUD_HOST,
        credentials: credentials.data,
      });
    }
    return err(response.error);
  }

  const user = bitbucketUserSchema.safeParse(response.data.body);
  if (!user.success) {
    return err({ type: 'generic', message: 'Bitbucket returned an unexpected user profile.' });
  }
  const id = user.data.uuid ?? user.data.account_id ?? undefined;
  const login = user.data.username ?? user.data.nickname ?? undefined;
  const displayName = user.data.display_name ?? login ?? undefined;
  const displayDetail =
    login && displayName && login !== displayName
      ? `@${login} · ${BITBUCKET_CLOUD_HOST}`
      : BITBUCKET_CLOUD_HOST;

  return ok({
    ...(id
      ? {
          account: {
            id,
            ...(login ? { login } : {}),
            ...(user.data.links?.avatar?.href ? { avatarUrl: user.data.links.avatar.href } : {}),
            host: BITBUCKET_CLOUD_HOST,
            scope: BITBUCKET_CLOUD_WEB_URL,
          },
        }
      : {}),
    ...(displayName ? { displayName } : {}),
    displayDetail,
    credentials: credentials.data,
  });
}
