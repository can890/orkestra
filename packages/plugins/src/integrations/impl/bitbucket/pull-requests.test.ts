import { describe, expect, it } from 'vitest';
import { createFakeFetch, type FakeRoute } from '../../helpers/fake-fetch.testing';
import { createBitbucketClient } from './client';
import {
  addBitbucketPullRequestComment,
  createBitbucketPullRequest,
  getBitbucketPullRequest,
  listBitbucketPullRequestChecks,
  listBitbucketPullRequestComments,
  listBitbucketPullRequests,
  mergeBitbucketPullRequest,
  toBitbucketBuildStatus,
  toBitbucketMergeStrategy,
  toBitbucketPullRequestState,
  toBitbucketStates,
} from './pull-requests';
import { type BitbucketCloudRepository, parseBitbucketRemote } from './remote';

const API = 'https://api.bitbucket.org/2.0';
const REPO_PATH = '/2.0/repositories/acme/web';
const repository = parseBitbucketRemote(
  'git@bitbucket.org:acme/web.git'
) as BitbucketCloudRepository;

/** Bitbucket Cloud `GET /pullrequests/{id}` yanıtının kaydedilmiş biçimi (kısaltılmış). */
function pullRequestFixture(overrides: Record<string, unknown> = {}) {
  return {
    type: 'pullrequest',
    id: 7,
    title: 'Add login',
    description: 'Implements login',
    state: 'OPEN',
    draft: false,
    author: {
      display_name: 'Ada Lovelace',
      nickname: 'ada',
      uuid: '{u1}',
      links: { avatar: { href: 'https://avatar.test/ada.png' } },
    },
    source: {
      branch: { name: 'feature/login' },
      commit: { hash: 'abc123def456', type: 'commit' },
      repository: { full_name: 'acme/web', type: 'repository' },
    },
    destination: {
      branch: { name: 'main' },
      commit: { hash: '0000aaaa1111' },
      repository: { full_name: 'acme/web' },
    },
    created_on: '2026-11-01T10:00:00.000000+00:00',
    updated_on: '2026-11-02T10:00:00.000000+00:00',
    closed_on: null,
    reviewers: [{ display_name: 'Grace', nickname: 'grace', uuid: '{u2}' }],
    links: { html: { href: 'https://bitbucket.org/acme/web/pull-requests/7' } },
    ...overrides,
  };
}

function setup(routes: FakeRoute[]) {
  const fake = createFakeFetch(routes);
  const client = createBitbucketClient(
    { email: 'ada@example.com', apiToken: 'tok' },
    { fetch: fake.fetch }
  );
  if (!client.success) throw new Error('client');
  return { client: client.data, fake };
}

describe('Bitbucket state mapping', () => {
  it.each([
    ['OPEN', 'open'],
    ['MERGED', 'merged'],
    ['DECLINED', 'closed'],
    ['SUPERSEDED', 'closed'],
    ['merged', 'merged'],
    [null, 'open'],
    ['SOMETHING_NEW', 'open'],
  ] as const)('maps PR state %s to %s', (raw, expected) => {
    expect(toBitbucketPullRequestState(raw)).toBe(expected);
  });

  it.each([
    ['SUCCESSFUL', 'success'],
    ['FAILED', 'failure'],
    ['STOPPED', 'cancelled'],
    ['INPROGRESS', 'pending'],
    ['UNKNOWN', 'neutral'],
    [undefined, 'neutral'],
  ] as const)('maps build status %s to %s', (raw, expected) => {
    expect(toBitbucketBuildStatus(raw)).toBe(expected);
  });

  it('maps state filters and merge strategies', () => {
    expect(toBitbucketStates('open')).toEqual(['OPEN']);
    expect(toBitbucketStates('closed')).toEqual(['DECLINED', 'SUPERSEDED']);
    expect(toBitbucketStates('all')).toEqual(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']);
    expect(toBitbucketMergeStrategy(undefined)).toBe('merge_commit');
    expect(toBitbucketMergeStrategy('squash')).toBe('squash');
    expect(toBitbucketMergeStrategy('rebase')).toBe('rebase_fast_forward');
  });
});

describe('Bitbucket pull request API', () => {
  it('lists pull requests with state, branch filter and pagination', async () => {
    const { client, fake } = setup([
      {
        match: (url) =>
          url.pathname === `${REPO_PATH}/pullrequests` && !url.searchParams.has('page'),
        body: {
          values: [pullRequestFixture(), { id: 'broken' }],
          next: `${API}/repositories/acme/web/pullrequests?page=2`,
        },
      },
      {
        match: (url) => url.searchParams.get('page') === '2',
        body: { values: [pullRequestFixture({ id: 8, state: 'MERGED' })] },
      },
    ]);
    const result = await listBitbucketPullRequests(client, repository, {
      state: 'all',
      sourceBranch: 'feature/"login"',
      limit: 5,
    });
    if (!result.success) throw new Error(result.error.message);
    expect(result.data.map((pr) => [pr.number, pr.state])).toEqual([
      [7, 'open'],
      [8, 'merged'],
    ]);
    expect(result.data[0]).toMatchObject({
      title: 'Add login',
      url: 'https://bitbucket.org/acme/web/pull-requests/7',
      headBranch: 'feature/login',
      headSha: 'abc123def456',
      baseBranch: 'main',
      author: { login: 'ada', name: 'Ada Lovelace', avatarUrl: 'https://avatar.test/ada.png' },
      reviewers: [{ login: 'grace' }],
    });
    const first = fake.calls[0].url;
    expect(first.searchParams.getAll('state')).toEqual([
      'OPEN',
      'MERGED',
      'DECLINED',
      'SUPERSEDED',
    ]);
    expect(first.searchParams.get('sort')).toBe('-updated_on');
    expect(first.searchParams.get('q')).toBe(
      '(state = "OPEN" OR state = "MERGED" OR state = "DECLINED" OR state = "SUPERSEDED") AND source.branch.name = "feature/\\"login\\""'
    );
  });

  it('reads detail with closed_on and conflict state', async () => {
    const { client, fake } = setup([
      { match: `${REPO_PATH}/pullrequests/7/conflicts`, body: { values: [{ path: 'a.ts' }] } },
      { match: `${REPO_PATH}/pullrequests/7`, body: pullRequestFixture() },
    ]);
    const result = await getBitbucketPullRequest(client, repository, 7);
    expect(result).toMatchObject({ success: true, data: { mergeability: 'conflicting' } });
    expect(fake.calls[0].url.searchParams.get('fields')).toBe('+closed_on');
  });

  it('creates a pull request with the expected body', async () => {
    const { client, fake } = setup([
      {
        method: 'POST',
        match: `${REPO_PATH}/pullrequests`,
        status: 201,
        body: pullRequestFixture(),
      },
    ]);
    const result = await createBitbucketPullRequest(client, repository, {
      title: 'Add login',
      description: 'Implements login',
      sourceBranch: 'feature/login',
      targetBranch: 'main',
      isDraft: true,
      closeSourceBranch: true,
    });
    expect(result).toMatchObject({ success: true, data: { number: 7 } });
    expect(fake.calls[0].body).toEqual({
      title: 'Add login',
      description: 'Implements login',
      source: { branch: { name: 'feature/login' } },
      destination: { branch: { name: 'main' } },
      close_source_branch: true,
      draft: true,
    });
  });

  it('reads build statuses, keeping the latest entry per key', async () => {
    const { client } = setup([
      {
        match: `${REPO_PATH}/pullrequests/7/statuses`,
        body: {
          values: [
            { key: 'pipeline-1', name: 'Pipeline #1', state: 'FAILED', url: 'https://ci/1' },
            { key: 'lint', name: 'Lint', state: 'SUCCESSFUL', description: 'ok' },
            { key: 'pipeline-1', name: 'Pipeline #1', state: 'INPROGRESS', url: 'https://ci/2' },
            { state: 'FAILED' },
          ],
        },
      },
    ]);
    expect(await listBitbucketPullRequestChecks(client, repository, 7)).toEqual({
      success: true,
      data: [
        { name: 'Pipeline #1', status: 'pending', description: null, url: 'https://ci/2' },
        { name: 'Lint', status: 'success', description: 'ok', url: null },
      ],
    });
  });

  it('lists comments, skipping deleted, pending and empty ones', async () => {
    const { client } = setup([
      {
        match: `${REPO_PATH}/pullrequests/7/comments`,
        body: {
          values: [
            {
              id: 1,
              content: { raw: 'Looks good' },
              user: { nickname: 'grace', display_name: 'Grace' },
              created_on: '2026-11-02T00:00:00Z',
              links: { html: { href: 'https://bitbucket.org/c/1' } },
            },
            {
              id: 2,
              content: { raw: 'Inline' },
              created_on: '2026-11-02T01:00:00Z',
              inline: { path: 'src/a.ts', to: 3 },
            },
            { id: 3, content: { raw: 'gone' }, deleted: true, created_on: '2026-11-02T02:00:00Z' },
            { id: 4, content: { raw: 'draft' }, pending: true, created_on: '2026-11-02T03:00:00Z' },
            { id: 5, content: { raw: '  ' }, created_on: '2026-11-02T04:00:00Z' },
          ],
        },
      },
    ]);
    const result = await listBitbucketPullRequestComments(client, repository, 7);
    if (!result.success) throw new Error(result.error.message);
    expect(result.data.map((comment) => [comment.id, comment.path])).toEqual([
      ['1', null],
      ['2', 'src/a.ts'],
    ]);
  });

  it('adds a comment', async () => {
    const { client, fake } = setup([
      {
        method: 'POST',
        match: `${REPO_PATH}/pullrequests/7/comments`,
        status: 201,
        body: { id: 9, content: { raw: 'Thanks' }, created_on: '2026-11-03T00:00:00Z' },
      },
    ]);
    expect(await addBitbucketPullRequestComment(client, repository, 7, 'Thanks')).toMatchObject({
      success: true,
      data: { id: '9', body: 'Thanks' },
    });
    expect(fake.calls[0].body).toEqual({ content: { raw: 'Thanks' } });
  });

  it('merges only the head that was read', async () => {
    const routes: FakeRoute[] = [
      { match: `${REPO_PATH}/pullrequests/7/conflicts`, body: { values: [] } },
      {
        method: 'POST',
        match: `${REPO_PATH}/pullrequests/7/merge`,
        body: pullRequestFixture({ state: 'MERGED' }),
      },
      { method: 'GET', match: `${REPO_PATH}/pullrequests/7`, body: pullRequestFixture() },
    ];

    const stale = setup(routes);
    expect(
      await mergeBitbucketPullRequest(stale.client, repository, {
        number: 7,
        expectedHeadSha: 'ffffffffffffffff',
      })
    ).toMatchObject({ success: false, error: { type: 'invalid_input' } });
    expect(stale.fake.calls.some((call) => call.url.pathname.endsWith('/merge'))).toBe(false);

    const fresh = setup(routes);
    const merged = await mergeBitbucketPullRequest(fresh.client, repository, {
      number: 7,
      method: 'squash',
      expectedHeadSha: 'abc123def4567890abcdef',
      deleteSourceBranch: true,
    });
    expect(merged).toMatchObject({ success: true, data: { state: 'merged' } });
    const mergeCall = fresh.fake.calls.find((call) => call.url.pathname.endsWith('/merge'));
    expect(mergeCall?.body).toEqual({ merge_strategy: 'squash', close_source_branch: true });
  });

  it('surfaces API errors through the shared vocabulary', async () => {
    const { client } = setup([{ match: `${REPO_PATH}/pullrequests/7`, status: 404, body: {} }]);
    expect(await getBitbucketPullRequest(client, repository, 7)).toMatchObject({
      success: false,
      error: { type: 'not_found_or_no_access', status: 404 },
    });
  });
});
