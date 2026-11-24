import { describe, expect, it } from 'vitest';
import { createFakeFetch } from '../../helpers/fake-fetch.testing';
import {
  bitbucketAuthorization,
  createBitbucketClient,
  listBitbucketPages,
  verifyBitbucketCredentials,
} from './client';

const API = 'https://api.bitbucket.org/2.0';

describe('Bitbucket auth header', () => {
  it('uses Basic auth with an Atlassian email and API token', () => {
    expect(bitbucketAuthorization({ email: 'ada@example.com', apiToken: 'tok' })).toEqual({
      success: true,
      data: `Basic ${Buffer.from('ada@example.com:tok').toString('base64')}`,
    });
  });

  it('uses Bearer auth for an access token without email', () => {
    expect(bitbucketAuthorization({ apiToken: 'tok' })).toEqual({
      success: true,
      data: 'Bearer tok',
    });
  });

  it('rejects header-unsafe values instead of throwing with the token', () => {
    expect(bitbucketAuthorization({ apiToken: 'tok\nInjected: x' })).toMatchObject({
      success: false,
      error: { type: 'invalid_input' },
    });
  });
});

describe('verifyBitbucketCredentials', () => {
  it('returns the account identity from /user', async () => {
    const fake = createFakeFetch([
      {
        match: `${API}/user`,
        body: {
          uuid: '{1111-2222}',
          account_id: '557058:abc',
          username: 'ada',
          display_name: 'Ada Lovelace',
          links: { avatar: { href: 'https://avatar.test/ada.png' } },
        },
      },
    ]);
    const result = await verifyBitbucketCredentials(
      { email: ' ada@example.com ', apiToken: ' tok ' },
      { fetch: fake.fetch }
    );
    expect(result).toEqual({
      success: true,
      data: {
        account: {
          id: '{1111-2222}',
          login: 'ada',
          avatarUrl: 'https://avatar.test/ada.png',
          host: 'bitbucket.org',
          scope: 'https://bitbucket.org',
        },
        displayName: 'Ada Lovelace',
        displayDetail: '@ada · bitbucket.org',
        credentials: { email: 'ada@example.com', apiToken: 'tok' },
      },
    });
    expect(fake.calls[0].headers.authorization).toMatch(/^Basic /);
  });

  it('accepts a scoped access token that cannot read /user', async () => {
    const fake = createFakeFetch([{ match: `${API}/user`, status: 403, body: {} }]);
    const result = await verifyBitbucketCredentials({ apiToken: 'tok' }, { fetch: fake.fetch });
    expect(result).toMatchObject({
      success: true,
      data: { displayDetail: 'bitbucket.org', credentials: { apiToken: 'tok' } },
    });
    if (!result.success) throw new Error('unreachable');
    expect(result.data.account).toBeUndefined();
    expect(fake.calls[0].headers.authorization).toBe('Bearer tok');
  });

  it('fails on an invalid token', async () => {
    const fake = createFakeFetch([{ match: `${API}/user`, status: 401, body: {} }]);
    expect(
      await verifyBitbucketCredentials(
        { email: 'ada@example.com', apiToken: 'bad' },
        { fetch: fake.fetch }
      )
    ).toMatchObject({ success: false, error: { type: 'auth_failed' } });
  });

  it('rejects missing tokens before any request', async () => {
    const fake = createFakeFetch([]);
    expect(await verifyBitbucketCredentials({ email: 'x' }, { fetch: fake.fetch })).toMatchObject({
      success: false,
      error: { type: 'invalid_input' },
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('listBitbucketPages', () => {
  function http(routes: Parameters<typeof createFakeFetch>[0]) {
    const fake = createFakeFetch(routes);
    const client = createBitbucketClient({ apiToken: 'tok' }, { fetch: fake.fetch });
    if (!client.success) throw new Error('client');
    return { client: client.data, fake };
  }

  it('follows next links until the limit is reached', async () => {
    const { client, fake } = http([
      {
        match: (url) => url.pathname === '/2.0/items' && !url.searchParams.has('page'),
        body: { values: [1, 2], next: `${API}/items?page=2` },
      },
      {
        match: (url) => url.searchParams.get('page') === '2',
        body: { values: [3, 4], next: `${API}/items?page=3` },
      },
      { match: (url) => url.searchParams.get('page') === '3', body: { values: [5] } },
    ]);
    expect(await listBitbucketPages(client, { path: '/items' }, 3)).toEqual({
      success: true,
      data: [1, 2, 3],
    });
    expect(fake.calls).toHaveLength(2);
  });

  it('stops at the last page and at the page cap', async () => {
    const { client } = http([
      { match: '/2.0/items', body: { values: [1], next: `${API}/items?page=2` } },
    ]);
    const result = await listBitbucketPages(client, { path: '/items' }, 100, 3);
    expect(result).toEqual({ success: true, data: [1, 1, 1] });
  });

  it('refuses to follow next links to another host', async () => {
    const { client, fake } = http([
      { match: '/2.0/items', body: { values: [1], next: 'https://evil.test/steal' } },
    ]);
    expect(await listBitbucketPages(client, { path: '/items' }, 10)).toMatchObject({
      success: false,
      error: { type: 'invalid_input' },
    });
    expect(fake.calls).toHaveLength(1);
  });
});
