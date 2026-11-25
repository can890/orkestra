import { describe, expect, it } from 'vitest';
import { createFakeFetch, type FakeRoute } from '../../helpers/fake-fetch.testing';
import { createAzureDevOpsClient } from './client';
import {
  addAzureDevOpsPullRequestComment,
  createAzureDevOpsPullRequest,
  getAzureDevOpsPullRequest,
  listAzureDevOpsPullRequestChecks,
  listAzureDevOpsPullRequestComments,
  listAzureDevOpsPullRequestPage,
  listAzureDevOpsPullRequests,
  mergeAzureDevOpsPullRequest,
  toAzureDevOpsMergeability,
  toAzureDevOpsMergeStrategy,
  toAzureDevOpsPolicyCheck,
  toAzureDevOpsPullRequestState,
  toAzureDevOpsStatusFilter,
  toAzureDevOpsStatusState,
} from './pull-requests';
import { type AzureDevOpsRepository, parseAzureDevOpsRemote } from './remote';

const repository = parseAzureDevOpsRemote(
  'git@ssh.dev.azure.com:v3/acme/Web/api'
) as AzureDevOpsRepository;
const REPO_PATH = '/acme/Web/_apis/git/repositories/api';
const BUILD_POLICY = '0609b952-1397-4640-95ec-e00a01b2c241';
const REVIEWER_POLICY = 'fa4e907d-c16b-4a4c-9dfa-4906e5d171dd';

/** Azure DevOps `GET pullrequests/{id}` yanıtının kaydedilmiş biçimi (kısaltılmış). */
function pullRequestFixture(overrides: Record<string, unknown> = {}) {
  return {
    repository: {
      id: 'r1',
      name: 'api',
      url: 'https://dev.azure.com/acme/p-guid/_apis/git/repositories/r1',
      webUrl: 'https://dev.azure.com/acme/Web/_git/api',
      project: { id: 'p-guid', name: 'Web', state: 'wellFormed' },
    },
    pullRequestId: 42,
    codeReviewId: 42,
    status: 'active',
    createdBy: {
      displayName: 'Ada Lovelace',
      uniqueName: 'ada@example.com',
      imageUrl: 'https://img/ada',
    },
    creationDate: '2026-11-01T10:00:00.000Z',
    title: 'Add login',
    description: 'Implements login',
    sourceRefName: 'refs/heads/feature/login',
    targetRefName: 'refs/heads/main',
    mergeStatus: 'succeeded',
    isDraft: false,
    lastMergeSourceCommit: { commitId: 'a1b2c3d4e5f6' },
    lastMergeTargetCommit: { commitId: '0f0e0d0c0b0a' },
    reviewers: [{ displayName: 'Grace', uniqueName: 'grace@example.com', vote: 10 }],
    url: 'https://dev.azure.com/acme/p-guid/_apis/git/repositories/r1/pullRequests/42',
    ...overrides,
  };
}

function setup(routes: FakeRoute[]) {
  const fake = createFakeFetch(routes);
  const client = createAzureDevOpsClient(
    { organizationUrl: 'https://dev.azure.com/acme', personalAccessToken: 'pat' },
    { fetch: fake.fetch }
  );
  if (!client.success) throw new Error('client');
  return { client: client.data, fake };
}

describe('Azure DevOps state mapping', () => {
  it.each([
    ['active', 'open'],
    ['completed', 'merged'],
    ['abandoned', 'closed'],
    ['notSet', 'open'],
    [null, 'open'],
  ] as const)('maps PR status %s to %s', (raw, expected) => {
    expect(toAzureDevOpsPullRequestState(raw)).toBe(expected);
  });

  it.each([
    ['succeeded', 'mergeable'],
    ['conflicts', 'conflicting'],
    ['rejectedByPolicy', 'conflicting'],
    ['failure', 'conflicting'],
    ['queued', 'unknown'],
    [undefined, 'unknown'],
  ] as const)('maps merge status %s to %s', (raw, expected) => {
    expect(toAzureDevOpsMergeability(raw)).toBe(expected);
  });

  it.each([
    ['succeeded', 'success'],
    ['failed', 'failure'],
    ['error', 'failure'],
    ['pending', 'pending'],
    ['notApplicable', 'skipped'],
    ['notSet', 'neutral'],
  ] as const)('maps PR status state %s to %s', (raw, expected) => {
    expect(toAzureDevOpsStatusState(raw)).toBe(expected);
  });

  it('maps filters and merge strategies', () => {
    expect(toAzureDevOpsStatusFilter('open')).toBe('active');
    expect(toAzureDevOpsStatusFilter('merged')).toBe('completed');
    expect(toAzureDevOpsStatusFilter('closed')).toBe('abandoned');
    expect(toAzureDevOpsStatusFilter('all')).toBe('all');
    expect(toAzureDevOpsMergeStrategy(undefined)).toBe('noFastForward');
    expect(toAzureDevOpsMergeStrategy('squash')).toBe('squash');
    expect(toAzureDevOpsMergeStrategy('rebase')).toBe('rebase');
  });

  function policy(status: string, extra: Record<string, unknown> = {}) {
    return {
      status,
      context: { buildId: 77, buildDefinitionName: 'CI', isExpired: false },
      configuration: {
        url: 'https://dev.azure.com/acme/p-guid/_apis/policy/configurations/1',
        isBlocking: true,
        isEnabled: true,
        type: { id: BUILD_POLICY, displayName: 'Build' },
        settings: { displayName: 'PR build' },
      },
      ...extra,
    };
  }

  it.each([
    ['approved', 'success'],
    ['rejected', 'failure'],
    ['broken', 'failure'],
    ['running', 'pending'],
    ['notApplicable', 'skipped'],
    ['queued', 'pending'],
    ['brandNew', 'pending'],
  ] as const)('maps build policy %s to %s', (status, expected) => {
    expect(toAzureDevOpsPolicyCheck(policy(status), false)).toEqual({
      name: 'PR build',
      status: expected,
      description: null,
      url: 'https://dev.azure.com/acme/p-guid/_build/results?buildId=77',
      required: true,
    });
  });

  it('flags expired blocking builds as action required', () => {
    expect(
      toAzureDevOpsPolicyCheck(
        policy('queued', { context: { buildId: 77, isExpired: true } }),
        false
      )
    ).toMatchObject({ status: 'action-required', description: expect.stringContaining('Expired') });
  });

  it('ignores reviewer policies and held draft builds', () => {
    const reviewer = policy('approved');
    reviewer.configuration.type.id = REVIEWER_POLICY;
    expect(toAzureDevOpsPolicyCheck(reviewer, false)).toBeNull();
    expect(toAzureDevOpsPolicyCheck(policy('queued', { context: {} }), true)).toBeNull();
  });
});

describe('Azure DevOps pull request API', () => {
  it('lists pull requests with status and source filters', async () => {
    const { client, fake } = setup([
      {
        match: `${REPO_PATH}/pullrequests`,
        body: {
          value: [pullRequestFixture(), { pullRequestId: 'broken' }],
          count: 2,
        },
      },
    ]);
    const result = await listAzureDevOpsPullRequests(client, repository, {
      state: 'open',
      sourceBranch: 'feature/login',
      limit: 10,
    });
    if (!result.success) throw new Error(result.error.message);
    expect(result.data).toEqual([
      {
        number: 42,
        title: 'Add login',
        url: 'https://dev.azure.com/acme/Web/_git/api/pullrequest/42',
        body: 'Implements login',
        state: 'open',
        isDraft: false,
        author: { login: 'ada@example.com', name: 'Ada Lovelace', avatarUrl: 'https://img/ada' },
        headBranch: 'feature/login',
        headSha: 'a1b2c3d4e5f6',
        baseBranch: 'main',
        baseSha: '0f0e0d0c0b0a',
        mergeability: 'mergeable',
        createdAt: '2026-11-01T10:00:00.000Z',
        updatedAt: '2026-11-01T10:00:00.000Z',
        closedAt: null,
        reviewers: [{ login: 'grace@example.com', name: 'Grace', avatarUrl: null }],
      },
    ]);
    const params = fake.calls[0].url.searchParams;
    expect(params.get('searchCriteria.status')).toBe('active');
    expect(params.get('searchCriteria.sourceRefName')).toBe('refs/heads/feature/login');
    expect(params.get('$top')).toBe('10');
    expect(params.get('api-version')).toBe('7.1');
  });

  it('pages with $skip/$top and uses one look-ahead record as the only next-page evidence', async () => {
    const records = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) =>
        pullRequestFixture({ pullRequestId: from + index })
      );
    const { client, fake } = setup([
      {
        match: (url) => url.searchParams.get('$skip') === '0',
        body: { value: records(1, 3), count: 3 },
      },
      {
        match: (url) => url.searchParams.get('$skip') === '2',
        body: { value: records(3, 2), count: 2 },
      },
    ]);
    const first = await listAzureDevOpsPullRequestPage(client, repository, {
      state: 'all',
      pageSize: 2,
    });
    if (!first.success) throw new Error(first.error.message);
    expect(first.data.pullRequests.map((pr) => pr.number)).toEqual([1, 2]);
    expect(first.data.nextPage).toBe(2);
    expect(fake.calls[0].url.searchParams.get('$top')).toBe('3');
    expect(fake.calls[0].url.searchParams.get('searchCriteria.status')).toBe('all');

    // Tam dolu son sayfa: ileri bakış kaydı yok, devamı da yok.
    const last = await listAzureDevOpsPullRequestPage(client, repository, {
      state: 'all',
      page: 2,
      pageSize: 2,
    });
    if (!last.success) throw new Error(last.error.message);
    expect(last.data.pullRequests.map((pr) => pr.number)).toEqual([3, 4]);
    expect(last.data.nextPage).toBeNull();
  });

  it('creates a pull request', async () => {
    const { client, fake } = setup([
      {
        method: 'POST',
        match: `${REPO_PATH}/pullrequests`,
        status: 201,
        body: pullRequestFixture({ isDraft: true }),
      },
    ]);
    expect(
      await createAzureDevOpsPullRequest(client, repository, {
        title: 'Add login',
        description: 'Implements login',
        sourceBranch: 'feature/login',
        targetBranch: 'main',
        isDraft: true,
      })
    ).toMatchObject({ success: true, data: { number: 42, isDraft: true } });
    expect(fake.calls[0].body).toEqual({
      sourceRefName: 'refs/heads/feature/login',
      targetRefName: 'refs/heads/main',
      title: 'Add login',
      description: 'Implements login',
      isDraft: true,
    });
  });

  it('combines build policies and external statuses into checks', async () => {
    const { client, fake } = setup([
      { match: `${REPO_PATH}/pullrequests/42`, body: pullRequestFixture() },
      {
        match: '/acme/Web/_apis/policy/evaluations',
        body: {
          value: [
            {
              status: 'running',
              context: { buildId: 5, buildDefinitionName: 'CI' },
              configuration: {
                url: 'https://dev.azure.com/acme/p-guid/_apis/policy/configurations/3',
                isBlocking: true,
                isEnabled: true,
                type: { id: BUILD_POLICY, displayName: 'Build' },
                settings: {},
              },
            },
            {
              status: 'approved',
              configuration: { isEnabled: true, type: { id: REVIEWER_POLICY } },
            },
          ],
          count: 2,
        },
      },
      {
        match: `${REPO_PATH}/pullRequests/42/statuses`,
        body: {
          value: [
            { id: 1, state: 'pending', context: { name: 'scan', genre: 'security' } },
            {
              id: 2,
              state: 'succeeded',
              context: { name: 'scan', genre: 'security' },
              targetUrl: 'https://scan/2',
            },
          ],
        },
      },
    ]);
    expect(await listAzureDevOpsPullRequestChecks(client, repository, 42)).toEqual({
      success: true,
      data: [
        {
          name: 'CI',
          status: 'pending',
          description: null,
          url: 'https://dev.azure.com/acme/p-guid/_build/results?buildId=5',
          required: true,
        },
        { name: 'security/scan', status: 'success', description: null, url: 'https://scan/2' },
      ],
    });
    const evaluation = fake.calls.find((call) => call.url.pathname.endsWith('/evaluations'));
    expect(evaluation?.url.searchParams.get('artifactId')).toBe(
      'vstfs:///CodeReview/CodeReviewId/p-guid/42'
    );
    expect(evaluation?.url.searchParams.get('api-version')).toBe('7.1-preview.1');
  });

  it('lists text comments from threads and skips system ones', async () => {
    const { client } = setup([
      {
        match: `${REPO_PATH}/pullRequests/42/threads`,
        body: {
          value: [
            {
              id: 1,
              comments: [
                {
                  id: 1,
                  content: 'Looks good',
                  author: { displayName: 'Grace', uniqueName: 'grace@example.com' },
                  publishedDate: '2026-11-02T00:00:00Z',
                  commentType: 'text',
                },
              ],
            },
            {
              id: 2,
              threadContext: { filePath: '/src/a.ts' },
              comments: [{ id: 1, content: 'Inline', publishedDate: '2026-11-02T01:00:00Z' }],
            },
            {
              id: 3,
              comments: [{ id: 1, content: 'Ada voted 10', commentType: 'system' }],
            },
            { id: 4, isDeleted: true, comments: [{ id: 1, content: 'gone' }] },
          ],
        },
      },
    ]);
    const result = await listAzureDevOpsPullRequestComments(client, repository, 42);
    if (!result.success) throw new Error(result.error.message);
    expect(result.data.map((comment) => [comment.id, comment.path, comment.url])).toEqual([
      ['1:1', null, 'https://dev.azure.com/acme/Web/_git/api/pullrequest/42?discussionId=1'],
      ['2:1', '/src/a.ts', 'https://dev.azure.com/acme/Web/_git/api/pullrequest/42?discussionId=2'],
    ]);
  });

  it('adds a comment as a new active thread', async () => {
    const { client, fake } = setup([
      {
        method: 'POST',
        match: `${REPO_PATH}/pullRequests/42/threads`,
        body: {
          id: 9,
          comments: [{ id: 1, content: 'Thanks', publishedDate: '2026-11-03T00:00:00Z' }],
        },
      },
    ]);
    expect(await addAzureDevOpsPullRequestComment(client, repository, 42, 'Thanks')).toMatchObject({
      success: true,
      data: { id: '9:1', body: 'Thanks' },
    });
    expect(fake.calls[0].body).toEqual({
      comments: [{ parentCommentId: 0, content: 'Thanks', commentType: 1 }],
      status: 1,
    });
  });

  it('completes the pull request at the head that was read', async () => {
    const routes: FakeRoute[] = [
      {
        method: 'PATCH',
        match: `${REPO_PATH}/pullrequests/42`,
        body: pullRequestFixture({ status: 'completed', closedDate: '2026-11-04T00:00:00Z' }),
      },
      { method: 'GET', match: `${REPO_PATH}/pullrequests/42`, body: pullRequestFixture() },
    ];

    const stale = setup(routes);
    expect(
      await mergeAzureDevOpsPullRequest(stale.client, repository, {
        number: 42,
        expectedHeadSha: 'ffff',
      })
    ).toMatchObject({ success: false, error: { type: 'invalid_input' } });
    expect(stale.fake.calls.some((call) => call.method === 'PATCH')).toBe(false);

    const fresh = setup(routes);
    expect(
      await mergeAzureDevOpsPullRequest(fresh.client, repository, {
        number: 42,
        method: 'squash',
        expectedHeadSha: 'A1B2C3D4E5F6',
        deleteSourceBranch: true,
      })
    ).toMatchObject({
      success: true,
      data: { state: 'merged', closedAt: '2026-11-04T00:00:00Z' },
    });
    expect(fresh.fake.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      status: 'completed',
      lastMergeSourceCommit: { commitId: 'a1b2c3d4e5f6' },
      completionOptions: { mergeStrategy: 'squash', deleteSourceBranch: true },
    });
  });

  it('maps API errors', async () => {
    const { client } = setup([{ match: `${REPO_PATH}/pullrequests/42`, status: 403, body: {} }]);
    expect(await getAzureDevOpsPullRequest(client, repository, 42)).toMatchObject({
      success: false,
      error: { type: 'auth_failed', status: 403 },
    });
  });
});
