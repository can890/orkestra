import { describe, expect, it } from 'vitest';
import { createFakeFetch } from './fake-fetch.testing';
import {
  basicAuthorization,
  bearerAuthorization,
  createHttpClient,
  retryAtFromHeader,
} from './http-client';

const SECRET = 'super-secret-token';

function client(routes: Parameters<typeof createFakeFetch>[0], extra = {}) {
  const fake = createFakeFetch(routes);
  return {
    fake,
    client: createHttpClient({
      provider: 'Forge',
      baseUrl: 'https://api.forge.test/2.0/',
      authorization: bearerAuthorization(SECRET),
      fetch: fake.fetch,
      ...extra,
    }),
  };
}

describe('createHttpClient', () => {
  it('sends the authorization header, JSON body and repeated query values', async () => {
    const { client: http, fake } = client([{ match: '/2.0/items', body: { ok: true } }]);
    const result = await http.request({
      method: 'POST',
      path: '/items',
      query: { state: ['OPEN', 'MERGED'], pagelen: 10, skip: undefined },
      body: { title: 'x' },
    });
    expect(result).toMatchObject({ success: true, data: { status: 200, body: { ok: true } } });
    const [call] = fake.calls;
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.url.searchParams.getAll('state')).toEqual(['OPEN', 'MERGED']);
    expect(call.url.searchParams.get('pagelen')).toBe('10');
    expect(call.url.searchParams.has('skip')).toBe(false);
    expect(call.body).toEqual({ title: 'x' });
  });

  it('follows absolute URLs only on the API origin', async () => {
    const { client: http, fake } = client([{ match: '/2.0/next', body: {} }]);
    expect((await http.request({ path: 'https://api.forge.test/2.0/next?page=2' })).success).toBe(
      true
    );
    const refused = await http.request({ path: 'https://evil.test/2.0/next' });
    expect(refused).toMatchObject({ success: false, error: { type: 'invalid_input' } });
    expect(fake.calls).toHaveLength(1);
  });

  it.each([
    [401, 'auth_failed'],
    [403, 'auth_failed'],
    [404, 'not_found_or_no_access'],
    [500, 'host_unreachable'],
    [503, 'host_unreachable'],
  ])('maps HTTP %i to %s without leaking credentials', async (status, type) => {
    const { client: http } = client([{ match: '/2.0/x', status, body: { error: SECRET } }]);
    const result = await http.request({ path: '/x' });
    expect(result).toMatchObject({ success: false, error: { type, status } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('reports rate limits with the retry time', async () => {
    const { client: http } = client([
      { match: '/2.0/x', status: 429, body: {}, headers: { 'retry-after': '30' } },
    ]);
    const result = await http.request({ path: '/x' });
    expect(result).toMatchObject({ success: false, error: { type: 'rate_limited', status: 429 } });
    if (result.success || result.error.type !== 'rate_limited') throw new Error('unreachable');
    expect(Date.parse(result.error.resetAt ?? '')).toBeGreaterThan(Date.now());
  });

  it('treats a non-JSON sign-in page as an authentication failure when asked', async () => {
    const { client: http } = client(
      [{ match: '/2.0/x', status: 203, text: '<html>Sign in</html>' }],
      { treatNonJsonAsAuthFailure: true }
    );
    expect(await http.request({ path: '/x' })).toMatchObject({
      success: false,
      error: { type: 'auth_failed' },
    });
  });

  it('maps network failures to host_unreachable', async () => {
    const http = createHttpClient({
      provider: 'Forge',
      baseUrl: 'https://api.forge.test',
      authorization: bearerAuthorization(SECRET),
      fetch: async () => {
        throw Object.assign(new TypeError(`fetch failed ${SECRET}`), {
          cause: { code: 'ENOTFOUND' },
        });
      },
    });
    const result = await http.request({ path: '/x' });
    expect(result).toMatchObject({ success: false, error: { type: 'host_unreachable' } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('returns null bodies for empty responses', async () => {
    const { client: http } = client([{ match: '/2.0/x', status: 204 }]);
    expect(await http.request({ method: 'DELETE', path: '/x' })).toMatchObject({
      success: true,
      data: { status: 204, body: null },
    });
  });
});

describe('auth helpers', () => {
  it('builds Basic and Bearer headers', () => {
    expect(basicAuthorization('ada@example.com', 'tok')).toBe(
      `Basic ${Buffer.from('ada@example.com:tok').toString('base64')}`
    );
    expect(basicAuthorization('', 'pat')).toBe(`Basic ${Buffer.from(':pat').toString('base64')}`);
    expect(bearerAuthorization('tok')).toBe('Bearer tok');
  });

  it('parses Retry-After seconds and dates', () => {
    expect(retryAtFromHeader('10', 0)).toBe(new Date(10_000).toISOString());
    expect(retryAtFromHeader('Wed, 21 Oct 2026 07:28:00 GMT')).toBe('2026-10-21T07:28:00.000Z');
    expect(retryAtFromHeader(null)).toBeUndefined();
    expect(retryAtFromHeader('soon')).toBeUndefined();
  });
});
