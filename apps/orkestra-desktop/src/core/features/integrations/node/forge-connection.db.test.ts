import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ayarlar → Entegrasyonlar'daki "Bağlan" formunun ana süreçteki yolu: gerçek Bitbucket ve
 * Azure DevOps doğrulaması → kimlik bilgisinin saklanması → hesabın kaldırılması.
 * Gerçek ağ çağrısı yoktur: genel `fetch` kaydedilmiş yanıtlar döndüren sahteyle değişir.
 */

type Route = { path: string; status?: number; body: unknown };

function stubFetch(routes: Route[]): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(input);
    calls.push(url);
    const route = routes.find((candidate) => url.pathname.startsWith(candidate.path));
    if (!route) throw new Error(`Unexpected request ${url.toString()}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

describe('Bitbucket and Azure DevOps account connection', () => {
  let fixture: RegistryFixture;

  beforeEach(async () => {
    fixture = await openRegistryFixture();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fixture?.close();
  });

  it('connects a Bitbucket API token to the verified Atlassian user and removes it', async () => {
    stubFetch([
      {
        path: '/2.0/user',
        body: { uuid: '{u-1}', username: 'ada', display_name: 'Ada Lovelace' },
      },
    ]);

    const result = await fixture.connections.connect('bitbucket', {
      email: 'ada@example.com',
      apiToken: 'bb-token',
    });
    if (!result.success) throw new Error(result.error);

    const [account] = await fixture.registry.listAccounts('bitbucket');
    expect(account).toMatchObject({ accountId: result.accountId, isDefault: true });
    expect(await fixture.integrationAccounts.getAccount('bitbucket', result.accountId)).toEqual(
      expect.objectContaining({
        displayName: 'Ada Lovelace',
        credentials: { email: 'ada@example.com', apiToken: 'bb-token' },
      })
    );

    await fixture.registry.removeAccount('bitbucket', result.accountId);
    expect(await fixture.registry.listAccounts('bitbucket')).toEqual([]);
  });

  it('accepts a Bitbucket workspace access token that has no user identity', async () => {
    stubFetch([{ path: '/2.0/user', status: 403, body: { error: { message: 'Forbidden' } } }]);

    const result = await fixture.connections.connect('bitbucket', {
      email: '',
      apiToken: 'workspace-token',
    });
    if (!result.success) throw new Error(result.error);
    expect(result.displayName).toBe('Bitbucket access token');
    expect(await fixture.registry.listAccounts('bitbucket')).toHaveLength(1);
  });

  it('connects an Azure DevOps organization with a personal access token', async () => {
    const calls = stubFetch([
      {
        path: '/acme/_apis/connectionData',
        body: {
          authenticatedUser: {
            id: 'user-1',
            providerDisplayName: 'Ada Lovelace',
            properties: { Account: { $value: 'ada@example.com' } },
          },
        },
      },
      { path: '/acme/_apis/projects', body: { count: 1, value: [{ id: 'p', name: 'Web' }] } },
    ]);

    const result = await fixture.connections.connect('azure-devops', {
      organizationUrl: 'https://dev.azure.com/acme/',
      personalAccessToken: 'ado-token',
    });
    if (!result.success) throw new Error(result.error);

    expect(result.displayDetail).toBe('dev.azure.com/acme');
    expect(calls.every((url) => url.origin === 'https://dev.azure.com')).toBe(true);
    expect(await fixture.registry.listAccounts('azure-devops')).toHaveLength(1);
  });

  it('reports a rejected token without saving an account', async () => {
    stubFetch([{ path: '/acme/_apis', status: 401, body: {} }]);

    const result = await fixture.connections.connect('azure-devops', {
      organizationUrl: 'https://dev.azure.com/acme',
      personalAccessToken: 'expired',
    });
    expect(result.success).toBe(false);
    expect(await fixture.registry.listAccounts('azure-devops')).toEqual([]);
  });
});
