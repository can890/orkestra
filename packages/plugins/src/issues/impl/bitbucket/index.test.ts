import type { Logger } from '@orkestra/shared/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeFetch, type FakeRoute } from '../../../integrations/helpers/fake-fetch.testing';
import type { ConnectedIntegrationHostContext } from '../../../integrations/host';
import { issuesPluginRegistry } from '../../registry';

const REPO_URL = 'https://bitbucket.org/acme/web';
const ISSUES_PATH = '/2.0/repositories/acme/web/issues';

const issues = issuesPluginRegistry.get('bitbucket')?.behavior.issues;
if (!issues) throw new Error('Bitbucket issues behavior is not registered.');

function makeHost(): ConnectedIntegrationHostContext & { warnings: unknown[] } {
  const warnings: unknown[] = [];
  const log: Logger = {
    level: 'info',
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => warnings.push(args),
    error: () => {},
    child: () => log,
  };
  return {
    log,
    warnings,
    credentials: { email: 'ada@example.com', apiToken: 'secret-token' },
  };
}

/** Bitbucket Cloud `GET /issues` kaydının kaydedilmiş biçimi (kısaltılmış). */
function issueFixture(id: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'issue',
    id,
    title: `Issue ${id}`,
    state: 'open',
    kind: 'bug',
    priority: 'major',
    content: { raw: 'Steps to reproduce', markup: 'markdown', html: '<p>Steps</p>' },
    assignee: { display_name: 'Grace', nickname: 'grace' },
    reporter: { display_name: 'Ada', nickname: 'ada' },
    updated_on: '2026-11-02T10:00:00.000000+00:00',
    links: { html: { href: `https://bitbucket.org/acme/web/issues/${id}` } },
    ...extra,
  };
}

function stubFetch(routes: FakeRoute[]) {
  const fake = createFakeFetch(routes);
  vi.stubGlobal('fetch', fake.fetch);
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bitbucket issues plugin', () => {
  it('lists open issues of the remote repository', async () => {
    const fake = stubFetch([
      { match: ISSUES_PATH, body: { values: [issueFixture(3), issueFixture(1)] } },
    ]);
    const result = await issues.listIssues(makeHost(), { repositoryUrl: REPO_URL, limit: 10 });
    expect(result).toEqual({
      success: true,
      data: [
        {
          identifier: '#3',
          title: 'Issue 3',
          url: 'https://bitbucket.org/acme/web/issues/3',
          description: 'Steps to reproduce',
          status: 'open',
          assignees: ['Grace'],
          project: 'web',
          updatedAt: '2026-11-02T10:00:00.000000+00:00',
        },
        expect.objectContaining({ identifier: '#1' }),
      ],
    });
    const call = fake.calls[0];
    expect(call.url.origin).toBe('https://api.bitbucket.org');
    expect(call.url.searchParams.get('q')).toBe(
      '(state = "new" OR state = "open" OR state = "on hold")'
    );
    expect(call.url.searchParams.get('sort')).toBe('-updated_on');
    expect(call.url.searchParams.get('pagelen')).toBe('10');
    expect(call.headers.authorization).toBe(
      `Basic ${Buffer.from('ada@example.com:secret-token').toString('base64')}`
    );
  });

  it('accepts SSH remotes', async () => {
    stubFetch([{ match: ISSUES_PATH, body: { values: [] } }]);
    expect(
      await issues.listIssues(makeHost(), {
        repositoryUrl: 'git@bitbucket.org:acme/web.git',
        limit: 5,
      })
    ).toEqual({ success: true, data: [] });
  });

  it('searches titles, bodies and issue numbers', async () => {
    const fake = stubFetch([{ match: ISSUES_PATH, body: { values: [issueFixture(12)] } }]);
    const result = await issues.searchIssues(makeHost(), {
      repositoryUrl: REPO_URL,
      searchTerm: '#12',
      limit: 20,
    });
    expect(result).toMatchObject({ success: true, data: [{ identifier: '#12' }] });
    expect(fake.calls[0].url.searchParams.get('q')).toBe(
      '(state = "new" OR state = "open" OR state = "on hold") AND (title ~ "#12" OR content.raw ~ "#12" OR id = 12)'
    );
  });

  it('returns issue context with comments', async () => {
    stubFetch([
      {
        match: `${ISSUES_PATH}/12/comments`,
        body: {
          values: [
            {
              id: 1,
              content: { raw: 'Confirmed' },
              user: { display_name: 'Grace' },
              created_on: '2026-11-03',
            },
            { id: 2, content: { raw: null }, created_on: '2026-11-04' },
          ],
        },
      },
      { match: `${ISSUES_PATH}/12`, body: issueFixture(12) },
    ]);
    const result = await issues.getIssue?.(makeHost(), {
      identifier: '#12',
      repositoryUrl: REPO_URL,
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        identifier: '#12',
        context:
          'Kind: bug\nPriority: major\nReporter: Ada\n\nComments:\n- Grace (2026-11-03): Confirmed',
      },
    });
  });

  it('explains a disabled issue tracker', async () => {
    const host = makeHost();
    stubFetch([{ match: ISSUES_PATH, status: 404, body: { type: 'error' } }]);
    const result = await issues.listIssues(host, { repositoryUrl: REPO_URL, limit: 5 });
    expect(result).toMatchObject({ success: false, error: { type: 'not_found_or_no_access' } });
    if (result.success) throw new Error('unreachable');
    expect(result.error.message).toContain('not enabled');
    expect(JSON.stringify(host.warnings)).not.toContain('secret-token');
  });

  it('rejects Data Center and foreign remotes before any request', async () => {
    const fake = stubFetch([]);
    for (const repositoryUrl of [
      'https://bitbucket.example.com/scm/PROJ/web.git',
      'https://github.com/acme/web',
    ]) {
      expect(await issues.listIssues(makeHost(), { repositoryUrl, limit: 5 })).toMatchObject({
        success: false,
        error: { type: 'unsupported_host' },
      });
    }
    expect(fake.calls).toHaveLength(0);
  });
});
