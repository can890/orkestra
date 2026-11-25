import { err, ok } from '@orkestra/shared';
import { createScope, type Scope } from '@orkestra/shared/concurrency';
import { createStubLogger } from '@orkestra/shared/testing';
import type { ContractClient } from '@orkestra/wire/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForgeAuth, GitHubAuthContract, GitHubAuthError } from '../api';
import { createPullRequestEngine, MAX_FORGE_PAGES } from './engine';
import { PullRequestService } from './pull-request-service';
import { PullRequestStore, pullRequestSqliteStore } from './store';

/**
 * Bitbucket Cloud ve Azure DevOps PR yolunun hizmet düzeyi testleri: gerçek önbellek (geçici
 * SQLite), gerçek yönlendirici motor ve sağlayıcı istemcileri; yalnızca HTTP sahte. Gerçek ağ ya
 * da gerçek kimlik bilgisi kullanılmaz.
 */

type Route = {
  method?: string;
  path: string;
  /** Verilirse bu sorgu parametrelerinin hepsi eşleşmelidir (sayfalama rotaları için). */
  query?: Record<string, string>;
  status?: number;
  body?: unknown;
};

type Call = { method: string; url: URL; headers: Record<string, string>; body: unknown };

function fakeFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init.headers as Record<string, string> | undefined) ?? {}).map(
        ([key, value]) => [key.toLowerCase(), value]
      )
    );
    calls.push({
      method,
      url,
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const route = routes.find(
      (candidate) =>
        (candidate.method ?? 'GET') === method &&
        candidate.path === url.pathname &&
        Object.entries(candidate.query ?? {}).every(
          ([key, value]) => url.searchParams.get(key) === value
        )
    );
    if (!route) throw new Error(`Unexpected request: ${method} ${url.toString()}`);
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

function forgeAuth(
  forge: ForgeAuth | null,
  error?: GitHubAuthError
): ContractClient<GitHubAuthContract> & { resolveAuth: ReturnType<typeof vi.fn> } {
  return {
    resolveAuth: vi.fn(async () =>
      error
        ? err(error)
        : ok({
            token: '',
            host: 'forge',
            apiBaseUrl: '',
            accountId: 'acc-1',
            ...(forge ? { forge } : {}),
          })
    ),
  };
}

const scopes: Scope[] = [];
afterEach(async () => {
  for (const scope of scopes.splice(0).reverse()) await scope.dispose();
});

async function harness(
  repositoryUrl: string,
  githubAuth: ContractClient<GitHubAuthContract>,
  routes: Route[]
) {
  const scope = createScope();
  scopes.push(scope);
  const handle = await pullRequestSqliteStore.openTemp();
  scope.add(() => handle.close());
  const store = new PullRequestStore(handle);
  store.registerRepository(repositoryUrl);
  const http = fakeFetch(routes);
  const { logger } = createStubLogger();
  const service = new PullRequestService({
    scope,
    store,
    logger,
    githubAuth,
    engine: createPullRequestEngine({ githubAuth, scope, logger, fetch: http.fetch }),
  });
  return { service, store, http, signal: scope.signal };
}

// --- Bitbucket Cloud -------------------------------------------------------------------------

const BB_REPO = 'https://bitbucket.org/acme/web';
const BB_API = '/2.0/repositories/acme/web';
const BB_HEAD = 'abc123def456';

function bitbucketPullRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    title: 'Add login',
    description: 'Implements login',
    state: 'OPEN',
    draft: false,
    author: { display_name: 'Ada Lovelace', nickname: 'ada', uuid: '{u1}' },
    source: { branch: { name: 'feature/login' }, commit: { hash: BB_HEAD } },
    destination: { branch: { name: 'main' }, commit: { hash: '0000aaaa1111' } },
    created_on: '2026-11-01T10:00:00.000000+00:00',
    updated_on: '2026-11-02T10:00:00.000000+00:00',
    // Sağlayıcının döndürdüğü adres büyük/küçük harf farkıyla gelse de önbellek anahtarı kanoniktir.
    links: { html: { href: 'https://bitbucket.org/Acme/Web/pull-requests/7' } },
    ...overrides,
  };
}

const bitbucketCredentials: ForgeAuth = {
  provider: 'bitbucket',
  credentials: { email: 'ada@example.com', apiToken: 'bb-token' },
};

describe('Bitbucket Cloud pull requests through PullRequestService', () => {
  it('syncs the open inventory into the cache and associates the task branch', async () => {
    const h = await harness(BB_REPO, forgeAuth(bitbucketCredentials), [
      { path: `${BB_API}/pullrequests`, body: { values: [bitbucketPullRequest()] } },
    ]);

    await expect(
      h.service.refreshRepository({ repositoryUrl: BB_REPO, policy: 'force' })
    ).resolves.toEqual(ok());

    const list = h.service.listPullRequests({ repositoryUrls: [BB_REPO], cursor: null, limit: 50 });
    if (!list.success) throw new Error(JSON.stringify(list.error));
    expect(list.data.prs).toHaveLength(1);
    expect(list.data.prs[0]).toMatchObject({
      url: 'https://bitbucket.org/acme/web/pull-requests/7',
      provider: 'bitbucket',
      repositoryUrl: BB_REPO,
      headRepositoryUrl: BB_REPO,
      headRefName: 'feature/login',
      headRefOid: BB_HEAD,
      baseRefName: 'main',
      baseRefOid: '0000aaaa1111',
      identifier: '#7',
      status: 'open',
      author: { userName: 'ada', displayName: 'Ada Lovelace' },
    });
    // Basic (e-posta + API token); kimlik bilgisi yalnızca başlıkta.
    const listCall = h.http.calls.find((call) => call.url.pathname.endsWith('/pullrequests'));
    expect(listCall?.headers.authorization).toBe(
      `Basic ${Buffer.from('ada@example.com:bb-token').toString('base64')}`
    );
    expect(listCall?.url.searchParams.getAll('state')).toEqual(['OPEN']);

    const forHead = h.service.getPullRequestsForHead(BB_REPO, BB_REPO, 'feature/login');
    expect(forHead.success && forHead.data.prs.map((pr) => pr.url)).toEqual([
      'https://bitbucket.org/acme/web/pull-requests/7',
    ]);
  });

  it('lists every open PR across pages instead of stopping at the first page', async () => {
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => bitbucketPullRequest({ id: from + index }));
    const h = await harness(BB_REPO, forgeAuth(bitbucketCredentials), [
      {
        path: `${BB_API}/pullrequests`,
        query: { page: '1' },
        body: {
          values: page(1, 50),
          next: `https://api.bitbucket.org${BB_API}/pullrequests?page=2`,
        },
      },
      {
        path: `${BB_API}/pullrequests`,
        query: { page: '2' },
        body: {
          values: page(51, 50),
          next: `https://api.bitbucket.org${BB_API}/pullrequests?page=3`,
        },
      },
      { path: `${BB_API}/pullrequests`, query: { page: '3' }, body: { values: page(101, 7) } },
    ]);

    await expect(
      h.service.refreshRepository({ repositoryUrl: BB_REPO, policy: 'force' })
    ).resolves.toEqual(ok());

    expect(h.store.getOpenPullRequestNumbers(BB_REPO)).toHaveLength(107);
    expect(h.http.calls.map((call) => call.url.searchParams.get('page'))).toEqual(['1', '2', '3']);
  });

  it('reports the last page as final and the next page cursor on earlier pages', async () => {
    const auth = forgeAuth(bitbucketCredentials);
    const h = await harness(BB_REPO, auth, [
      {
        path: `${BB_API}/pullrequests`,
        query: { page: '1' },
        body: {
          values: [bitbucketPullRequest({ id: 1 })],
          next: `https://api.bitbucket.org${BB_API}/pullrequests?page=2`,
        },
      },
      {
        path: `${BB_API}/pullrequests`,
        query: { page: '2' },
        body: { values: [bitbucketPullRequest({ id: 2 })] },
      },
    ]);
    const scope = createScope();
    scopes.push(scope);
    const engine = createPullRequestEngine({
      githubAuth: auth,
      scope,
      logger: createStubLogger().logger,
      fetch: h.http.fetch,
    });
    const repository = await engine.openRepository(BB_REPO, h.signal);
    if (!repository.success) throw new Error(JSON.stringify(repository.error));
    const first = await repository.data.fetchOpenPage(null, h.signal);
    expect(first.success && first.data.data.pageInfo).toEqual({
      hasNextPage: true,
      endCursor: '2',
    });
    const last = await repository.data.fetchOpenPage('2', h.signal);
    expect(last.success && last.data.data.pageInfo).toEqual({
      hasNextPage: false,
      endCursor: null,
    });
    await expect(repository.data.fetchOpenPage('not-a-page', h.signal)).resolves.toMatchObject(
      err({ type: 'sync_failed' })
    );
  });

  it('stops a never-ending page chain at the page bound without claiming a complete inventory', async () => {
    let served = 0;
    const h = await harness(BB_REPO, forgeAuth(bitbucketCredentials), [
      {
        path: `${BB_API}/pullrequests`,
        get body() {
          served += 1;
          return {
            values: [bitbucketPullRequest({ id: served })],
            next: `https://api.bitbucket.org${BB_API}/pullrequests?page=${served + 1}`,
          };
        },
      },
    ]);
    const result = await h.service.refreshRepository({ repositoryUrl: BB_REPO, policy: 'force' });
    expect(result).toMatchObject(err({ type: 'sync_failed' }));
    expect(h.http.calls).toHaveLength(MAX_FORGE_PAGES);
    // Okunan sayfalar önbellekte kalır.
    expect(h.store.getOpenPullRequestNumbers(BB_REPO)).toHaveLength(MAX_FORGE_PAGES);
  });

  it('refreshes one PR with mergeability, build statuses and comments', async () => {
    const h = await harness(BB_REPO, forgeAuth(bitbucketCredentials), [
      { path: `${BB_API}/pullrequests/7`, body: bitbucketPullRequest() },
      { path: `${BB_API}/pullrequests/7/conflicts`, body: { values: [] } },
      {
        path: `${BB_API}/pullrequests/7/statuses`,
        body: {
          values: [
            { key: 'ci', name: 'Pipeline', state: 'SUCCESSFUL', url: 'https://ci.test/1' },
            { key: 'lint', name: 'Lint', state: 'INPROGRESS' },
          ],
        },
      },
      {
        path: `${BB_API}/pullrequests/7/comments`,
        body: {
          values: [
            {
              id: 1,
              content: { raw: 'Looks good' },
              user: { display_name: 'Grace', nickname: 'grace' },
              created_on: '2026-11-03T10:00:00Z',
            },
            {
              id: 2,
              content: { raw: 'Rename this' },
              user: { nickname: 'grace' },
              created_on: '2026-11-03T11:00:00Z',
              inline: { path: 'src/login.ts' },
            },
          ],
        },
      },
    ]);

    await expect(
      h.service.refreshPullRequest({
        repositoryUrl: BB_REPO,
        number: 7,
        comments: true,
        policy: 'force',
      })
    ).resolves.toEqual(ok());

    const url = 'https://bitbucket.org/acme/web/pull-requests/7';
    const pr = h.store.getPullRequestByUrl(url);
    expect(pr).toMatchObject({ mergeableStatus: 'MERGEABLE', headRefOid: BB_HEAD });
    expect(
      pr?.checks
        .map((check) => [check.name, check.status, check.conclusion])
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
    ).toEqual([
      ['Lint', 'IN_PROGRESS', null],
      ['Pipeline', 'COMPLETED', 'SUCCESS'],
    ]);
    expect(pr?.checks.every((check) => check.commitSha === BB_HEAD)).toBe(true);
    expect(
      h.store.getComments(url).map((comment) => [comment.kind, comment.body, comment.path])
    ).toEqual([
      ['issue', 'Looks good', null],
      ['review', 'Rename this', 'src/login.ts'],
    ]);
  });

  it('creates a PR from a task branch and merges it at the read head', async () => {
    const h = await harness(BB_REPO, forgeAuth(bitbucketCredentials), [
      { method: 'POST', path: `${BB_API}/pullrequests`, body: bitbucketPullRequest({ id: 9 }) },
      { path: `${BB_API}/pullrequests/9`, body: bitbucketPullRequest({ id: 9 }) },
      { path: `${BB_API}/pullrequests/9/conflicts`, body: { values: [] } },
      { path: `${BB_API}/pullrequests/9/statuses`, body: { values: [] } },
      {
        method: 'POST',
        path: `${BB_API}/pullrequests/9/merge`,
        body: bitbucketPullRequest({ id: 9, state: 'MERGED' }),
      },
    ]);

    await expect(
      h.service.createPullRequest(
        {
          repositoryUrl: 'git@bitbucket.org:acme/web.git',
          headRepositoryUrl: 'ssh://git@altssh.bitbucket.org:443/acme/web.git',
          head: 'feature/login',
          base: 'main',
          title: 'Add login',
          body: 'Implements login',
          draft: true,
        },
        h.signal
      )
    ).resolves.toEqual(ok({ url: 'https://bitbucket.org/acme/web/pull-requests/9', number: 9 }));
    const create = h.http.calls.find((call) => call.method === 'POST');
    expect(create?.body).toEqual({
      title: 'Add login',
      description: 'Implements login',
      source: { branch: { name: 'feature/login' } },
      destination: { branch: { name: 'main' } },
      draft: true,
    });

    await expect(
      h.service.mergePullRequest(
        BB_REPO,
        9,
        // Yerel tam SHA, sağlayıcının kısa SHA'sıyla önek olarak eşleşir.
        { strategy: 'squash', commitHeadOid: `${BB_HEAD}0123456789abcdef0123456789` },
        h.signal
      )
    ).resolves.toEqual(ok({ sha: null, merged: true }));
    const merge = h.http.calls.find((call) => call.url.pathname.endsWith('/merge'));
    expect(merge?.body).toEqual({ merge_strategy: 'squash' });
  });

  it('refuses fork PRs and unsupported actions with explicit errors', async () => {
    const h = await harness(BB_REPO, forgeAuth(bitbucketCredentials), []);
    const fork = await h.service.createPullRequest(
      {
        repositoryUrl: BB_REPO,
        headRepositoryUrl: 'https://bitbucket.org/ada/web',
        head: 'ada:feature',
        base: 'main',
        title: 'Fork',
        draft: false,
      },
      h.signal
    );
    expect(fork).toMatchObject(err({ type: 'create_failed' }));
    expect(
      await h.service.setPullRequestAutoMerge(
        BB_REPO,
        7,
        { enabled: true, strategy: 'merge' },
        h.signal
      )
    ).toMatchObject(err({ type: 'merge_failed', message: expect.stringContaining('Bitbucket') }));
    expect(await h.service.markReadyForReview(BB_REPO, 7, h.signal)).toMatchObject(
      err({ type: 'mark_ready_failed' })
    );
    expect(h.http.calls).toEqual([]);
  });

  it('maps a rejected token to forge_auth_required and fences the sync', async () => {
    const h = await harness(BB_REPO, forgeAuth(bitbucketCredentials), [
      { path: `${BB_API}/pullrequests`, status: 401, body: { error: { message: 'Unauthorized' } } },
    ]);
    const result = await h.service.refreshRepository({ repositoryUrl: BB_REPO, policy: 'force' });
    expect(result).toMatchObject(
      err({ type: 'forge_auth_required', provider: 'bitbucket', host: 'bitbucket.org' })
    );
  });

  it('fails closed without credentials when the desktop cannot resolve an account', async () => {
    const auth = forgeAuth(null, {
      type: 'auth_required',
      host: 'bitbucket.org',
      message: 'No Bitbucket account is configured for this project.',
    });
    const h = await harness(BB_REPO, auth, []);
    const result = await h.service.refreshRepository({ repositoryUrl: BB_REPO, policy: 'force' });
    expect(result).toEqual(
      err({
        type: 'forge_auth_required',
        provider: 'bitbucket',
        host: 'bitbucket.org',
        message: 'No Bitbucket account is configured for this project.',
      })
    );
    expect(h.http.calls).toEqual([]);
  });
});

// --- Azure DevOps Services -------------------------------------------------------------------

const ADO_REPO = 'https://dev.azure.com/acme/Web/_git/api';
const ADO_API = '/acme/Web/_apis/git/repositories/api';
const ADO_HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BUILD_POLICY = '0609b952-1397-4640-95ec-e00a01b2c241';

function azurePullRequest(overrides: Record<string, unknown> = {}) {
  return {
    pullRequestId: 42,
    title: 'Add login',
    description: 'Implements login',
    status: 'active',
    isDraft: false,
    mergeStatus: 'succeeded',
    createdBy: { displayName: 'Ada Lovelace', uniqueName: 'ada@example.com' },
    sourceRefName: 'refs/heads/feature/login',
    targetRefName: 'refs/heads/main',
    creationDate: '2026-11-01T10:00:00.000Z',
    lastMergeSourceCommit: { commitId: ADO_HEAD },
    lastMergeTargetCommit: { commitId: 'f00df00df00df00df00df00df00df00df00df00d' },
    repository: {
      name: 'api',
      webUrl: 'https://acme.visualstudio.com/Web/_git/api',
      project: { id: 'p-guid', name: 'Web' },
    },
    ...overrides,
  };
}

const azureCredentials: ForgeAuth = {
  provider: 'azure-devops',
  credentials: { organizationUrl: 'https://dev.azure.com/acme', personalAccessToken: 'pat' },
};

describe('Azure DevOps pull requests through PullRequestService', () => {
  it('syncs open PRs with canonical URLs and the PAT as Basic auth', async () => {
    const h = await harness(ADO_REPO, forgeAuth(azureCredentials), [
      { path: `${ADO_API}/pullrequests`, body: { value: [azurePullRequest()] } },
    ]);
    await expect(
      h.service.refreshRepository({ repositoryUrl: ADO_REPO, policy: 'force' })
    ).resolves.toEqual(ok());
    const list = h.service.listPullRequests({
      repositoryUrls: [ADO_REPO],
      cursor: null,
      limit: 50,
    });
    if (!list.success) throw new Error(JSON.stringify(list.error));
    expect(list.data.prs[0]).toMatchObject({
      url: 'https://dev.azure.com/acme/Web/_git/api/pullrequest/42',
      provider: 'azure-devops',
      headRefName: 'feature/login',
      headRefOid: ADO_HEAD,
      baseRefOid: 'f00df00df00df00df00df00df00df00df00df00d',
      mergeableStatus: 'MERGEABLE',
    });
    const call = h.http.calls[0];
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from(':pat').toString('base64')}`);
    expect(call.url.searchParams.get('searchCriteria.status')).toBe('active');
  });

  it('lists every open PR across $skip pages and stops on an exactly full last page', async () => {
    const records = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) =>
        azurePullRequest({ pullRequestId: from + index })
      );
    const h = await harness(ADO_REPO, forgeAuth(azureCredentials), [
      // 50'lik sayfa + 1 ileri bakış kaydı: devamı var.
      { path: `${ADO_API}/pullrequests`, query: { $skip: '0' }, body: { value: records(1, 51) } },
      // Tam 50 kayıt, ileri bakış yok: son sayfa, boş bir üçüncü istek yapılmaz.
      { path: `${ADO_API}/pullrequests`, query: { $skip: '50' }, body: { value: records(51, 50) } },
    ]);

    await expect(
      h.service.refreshRepository({ repositoryUrl: ADO_REPO, policy: 'force' })
    ).resolves.toEqual(ok());

    expect(h.store.getOpenPullRequestNumbers(ADO_REPO)).toHaveLength(100);
    expect(
      h.http.calls.map((call) => [
        call.url.searchParams.get('$skip'),
        call.url.searchParams.get('$top'),
      ])
    ).toEqual([
      ['0', '51'],
      ['50', '51'],
    ]);
  });

  it('refreshes one PR with policy checks, statuses and threads', async () => {
    const h = await harness(ADO_REPO, forgeAuth(azureCredentials), [
      { path: `${ADO_API}/pullrequests/42`, body: azurePullRequest() },
      {
        path: '/acme/Web/_apis/policy/evaluations',
        body: {
          value: [
            {
              status: 'rejected',
              context: { buildId: 77, buildDefinitionName: 'CI' },
              configuration: {
                url: 'https://dev.azure.com/acme/p-guid/_apis/policy/configurations/1',
                isBlocking: true,
                isEnabled: true,
                type: { id: BUILD_POLICY, displayName: 'Build' },
                settings: { displayName: 'PR build' },
              },
            },
          ],
        },
      },
      { path: `${ADO_API}/pullRequests/42/statuses`, body: { value: [] } },
      {
        path: `${ADO_API}/pullRequests/42/threads`,
        body: {
          value: [
            {
              id: 5,
              comments: [
                {
                  id: 1,
                  content: 'Please add a test',
                  commentType: 'text',
                  author: { displayName: 'Grace', uniqueName: 'grace@example.com' },
                  publishedDate: '2026-11-03T10:00:00Z',
                },
              ],
            },
          ],
        },
      },
    ]);
    await expect(
      h.service.refreshPullRequest({
        repositoryUrl: ADO_REPO,
        number: 42,
        comments: true,
        policy: 'force',
      })
    ).resolves.toEqual(ok());
    const url = 'https://dev.azure.com/acme/Web/_git/api/pullrequest/42';
    expect(h.store.getPullRequestByUrl(url)?.checks).toMatchObject([
      { name: 'PR build', status: 'COMPLETED', conclusion: 'FAILURE', commitSha: ADO_HEAD },
    ]);
    expect(h.store.getComments(url)).toMatchObject([
      { kind: 'issue', body: 'Please add a test', author: { userName: 'grace@example.com' } },
    ]);
  });

  it('creates and completes a PR', async () => {
    const h = await harness(ADO_REPO, forgeAuth(azureCredentials), [
      {
        method: 'POST',
        path: `${ADO_API}/pullrequests`,
        body: azurePullRequest({ pullRequestId: 43 }),
      },
      { path: `${ADO_API}/pullrequests/43`, body: azurePullRequest({ pullRequestId: 43 }) },
      {
        method: 'PATCH',
        path: `${ADO_API}/pullrequests/43`,
        body: azurePullRequest({ pullRequestId: 43, status: 'completed' }),
      },
      { path: '/acme/Web/_apis/policy/evaluations', body: { value: [] } },
      { path: `${ADO_API}/pullRequests/43/statuses`, body: { value: [] } },
    ]);
    await expect(
      h.service.createPullRequest(
        {
          repositoryUrl: 'git@ssh.dev.azure.com:v3/acme/Web/api',
          head: 'feature/login',
          base: 'main',
          title: 'Add login',
          draft: false,
        },
        h.signal
      )
    ).resolves.toEqual(
      ok({ url: 'https://dev.azure.com/acme/Web/_git/api/pullrequest/43', number: 43 })
    );
    expect(h.http.calls.find((call) => call.method === 'POST')?.body).toEqual({
      sourceRefName: 'refs/heads/feature/login',
      targetRefName: 'refs/heads/main',
      title: 'Add login',
      description: '',
      isDraft: false,
    });

    await expect(
      h.service.mergePullRequest(
        ADO_REPO,
        43,
        { strategy: 'merge', commitHeadOid: ADO_HEAD },
        h.signal
      )
    ).resolves.toEqual(ok({ sha: null, merged: true }));
    expect(h.http.calls.find((call) => call.method === 'PATCH')?.body).toMatchObject({
      status: 'completed',
      lastMergeSourceCommit: { commitId: ADO_HEAD },
      completionOptions: { mergeStrategy: 'noFastForward' },
    });
  });

  it('never sends a PAT to another organization', async () => {
    const h = await harness(
      ADO_REPO,
      forgeAuth({
        provider: 'azure-devops',
        credentials: { organizationUrl: 'https://dev.azure.com/other', personalAccessToken: 'pat' },
      }),
      []
    );
    const result = await h.service.refreshRepository({ repositoryUrl: ADO_REPO, policy: 'force' });
    expect(result).toMatchObject(
      err({
        type: 'forge_auth_required',
        provider: 'azure-devops',
        message: expect.stringContaining('"acme"'),
      })
    );
    expect(h.http.calls).toEqual([]);
  });
});
