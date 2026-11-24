import { integrationPluginRegistry } from '@orkestra/plugins/integrations';
import { issuesPluginRegistry } from '@orkestra/plugins/issues';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectIntegrationAccountResolver } from '@core/features/integrations/api/node/project-integration-account-resolver';
import { linkedIssueSchema } from '@core/primitives/linked-issues/api/linked-issue';
import type { StoredIntegrationAccounts } from '@core/primitives/project-settings/api';
import type { ProviderAccountSummary } from '@core/primitives/provider-accounts/api';
import { createIssueProviderRegistry } from './registry';

/**
 * Bitbucket ve Azure DevOps'un GitLab ile aynı yollardan keşfedildiğini ve uçtan uca
 * (hesap çözümü → eklenti → sahte HTTP yanıtı → LinkedIssue) çalıştığını doğrular.
 * Gerçek ağ çağrısı yoktur: genel `fetch` kaydedilmiş biçimde yanıtlar döndüren sahteyle değişir.
 */

const mocks = vi.hoisted(() => ({
  getAccount: vi.fn(),
  listAccounts: vi.fn(),
  checkConnection: vi.fn(),
}));

vi.mock('@core/features/integrations/node/integration-account-store-instance', () => ({
  getIntegrationAccountStore: () => ({ getAccount: mocks.getAccount }),
}));
vi.mock('@core/services/provider-accounts/node/provider-account-service', () => ({
  getProviderAccountService: () => ({ listAccounts: mocks.listAccounts }),
}));
vi.mock('@core/features/integrations/node/integration-connection-service', () => ({
  getIntegrationConnectionService: () => ({ checkConnection: mocks.checkConnection }),
}));

type Route = { method?: string; path: string; body: unknown };
type Call = { method: string; url: URL; authorization: string | undefined; body: unknown };

const CREDENTIALS: Record<string, Record<string, string>> = {
  bitbucket: { email: 'ada@example.com', apiToken: 'bb-secret' },
  'azure-devops': {
    organizationUrl: 'https://dev.azure.com/acme',
    personalAccessToken: 'ado-secret',
  },
};

function account(
  providerId: string,
  host: string,
  id: string,
  isDefault = false
): ProviderAccountSummary {
  return { providerId, accountId: `${providerId}:${id}`, displayName: id, host, isDefault };
}

function stubFetch(routes: Route[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      method,
      url,
      authorization: headers.Authorization,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const route = routes.find(
      (candidate) =>
        (candidate.method ?? 'GET') === method && url.pathname.startsWith(candidate.path)
    );
    if (!route) throw new Error(`Unexpected request ${method} ${url.toString()}`);
    return new Response(JSON.stringify(route.body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

describe('Bitbucket and Azure DevOps issue providers', () => {
  let accounts: ProviderAccountSummary[];
  let choices: StoredIntegrationAccounts;
  let registry: ReturnType<typeof createIssueProviderRegistry>;

  beforeEach(() => {
    vi.clearAllMocks();
    accounts = [];
    choices = {};
    mocks.listAccounts.mockImplementation(async (providerId: string) =>
      accounts.filter((candidate) => candidate.providerId === providerId)
    );
    mocks.getAccount.mockImplementation(async (providerId: string, accountId: string) => {
      const found = accounts.find(
        (candidate) => candidate.providerId === providerId && candidate.accountId === accountId
      );
      return found ? { ...found, credentials: CREDENTIALS[providerId] } : null;
    });
    registry = createIssueProviderRegistry({
      resolveProjectIntegrationAccount: createProjectIntegrationAccountResolver({
        getProjectRepositoryContext: vi.fn(async () => {
          throw new Error('Unexpected project repository read');
        }),
        getStoredIntegrationAccounts: async () => choices,
        listAccounts: mocks.listAccounts,
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('are discoverable through the same plugin registries as GitLab', () => {
    for (const id of ['gitlab', 'bitbucket', 'azure-devops']) {
      expect(integrationPluginRegistry.get(id)).toBeDefined();
      expect(issuesPluginRegistry.get(id)).toBeDefined();
      expect(registry.get(id as 'gitlab')).toBeDefined();
    }
  });

  it('lists Azure Boards work items for an SSH remote with the host-matched account', async () => {
    accounts = [
      account('azure-devops', 'dev.azure.com', 'acme', true),
      account('bitbucket', 'bitbucket.org', 'ada', true),
    ];
    const calls = stubFetch([
      { path: '/acme/Web/_apis/wit/workitemtypes', body: { value: [] } },
      { method: 'POST', path: '/acme/Web/_apis/wit/wiql', body: { workItems: [{ id: 4 }] } },
      {
        method: 'POST',
        path: '/acme/_apis/wit/workitemsbatch',
        body: {
          value: [
            {
              id: 4,
              fields: {
                'System.Title': 'Login broken',
                'System.State': 'Active',
                'System.TeamProject': 'Web',
                'System.ChangedDate': '2026-11-20T10:00:00Z',
              },
            },
          ],
        },
      },
    ]);

    const provider = registry.get('azure-devops');
    const result = await provider?.listIssues({
      repositoryUrl: 'git@ssh.dev.azure.com:v3/acme/Web/api',
    });

    expect(result).toEqual({
      success: true,
      data: [
        expect.objectContaining({
          provider: 'azure-devops',
          accountId: 'azure-devops:acme',
          identifier: '#4',
          title: 'Login broken',
          url: 'https://dev.azure.com/acme/Web/_workitems/edit/4',
          status: 'Active',
        }),
      ],
    });
    if (!result?.success) throw new Error('unreachable');
    expect(linkedIssueSchema.safeParse(result.data[0]).success).toBe(true);
    expect(mocks.getAccount).toHaveBeenCalledWith('azure-devops', 'azure-devops:acme');
    expect(calls.every((call) => call.url.origin === 'https://dev.azure.com')).toBe(true);
    expect(calls[0]?.authorization).toBe(`Basic ${Buffer.from(':ado-secret').toString('base64')}`);
  });

  it('matches a Bitbucket account through the altssh clone host and loads issue context', async () => {
    accounts = [account('bitbucket', 'bitbucket.org', 'ada', true)];
    const issue = {
      id: 9,
      title: 'Crash on save',
      state: 'new',
      kind: 'bug',
      content: { raw: 'It crashes' },
      updated_on: '2026-11-21T09:00:00Z',
      links: { html: { href: 'https://bitbucket.org/acme/web/issues/9' } },
    };
    const calls = stubFetch([
      { path: '/2.0/repositories/acme/web/issues/9/comments', body: { values: [] } },
      { path: '/2.0/repositories/acme/web/issues/9', body: issue },
      { path: '/2.0/repositories/acme/web/issues', body: { values: [issue] } },
    ]);
    const repositoryUrl = 'ssh://git@altssh.bitbucket.org:443/acme/web.git';
    const provider = registry.get('bitbucket');

    const list = await provider?.listIssues({ repositoryUrl });
    expect(list).toMatchObject({
      success: true,
      data: [{ provider: 'bitbucket', accountId: 'bitbucket:ada', identifier: '#9' }],
    });

    const context = await provider?.getIssueContext?.({
      repositoryUrl,
      identifier: '#9',
      issueUrl: 'https://bitbucket.org/acme/web/issues/9',
    });
    expect(context).toMatchObject({
      success: true,
      data: {
        provider: 'bitbucket',
        identifier: '#9',
        description: 'It crashes',
        context: 'Kind: bug',
      },
    });
    if (!context?.success) throw new Error('unreachable');
    expect(linkedIssueSchema.safeParse(context.data).success).toBe(true);
    expect(calls.every((call) => call.url.origin === 'https://api.bitbucket.org')).toBe(true);
  });

  it('does not infer an account from another provider host', async () => {
    accounts = [account('azure-devops', 'dev.azure.com', 'acme', true)];
    const calls = stubFetch([]);
    const result = await registry
      .get('azure-devops')
      ?.listIssues({ repositoryUrl: 'https://bitbucket.org/acme/web' });
    expect(result).toMatchObject({ success: false, error: { type: 'auth_required' } });
    expect(calls).toHaveLength(0);
  });
});
