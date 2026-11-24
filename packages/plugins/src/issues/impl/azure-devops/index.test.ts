import type { Logger } from '@orkestra/shared/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeFetch, type FakeRoute } from '../../../integrations/helpers/fake-fetch.testing';
import type { ConnectedIntegrationHostContext } from '../../../integrations/host';
import { issuesPluginRegistry } from '../../registry';
import { buildWorkItemQuery } from './index';
import { closedStateNames, htmlToText, STOCK_CLOSED_STATES } from './mapper';

const REPO_URL = 'https://dev.azure.com/acme/Web/_git/api';

const issues = issuesPluginRegistry.get('azure-devops')?.behavior.issues;
if (!issues) throw new Error('Azure DevOps issues behavior is not registered.');

function makeHost(organizationUrl = 'https://dev.azure.com/acme'): ConnectedIntegrationHostContext {
  const log: Logger = {
    level: 'info',
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => log,
  };
  return { log, credentials: { organizationUrl, personalAccessToken: 'secret-pat' } };
}

/** `workitemsbatch` yanıtındaki bir iş öğesinin kaydedilmiş biçimi (kısaltılmış). */
function workItem(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    rev: 3,
    fields: {
      'System.Id': id,
      'System.Title': `Work item ${id}`,
      'System.State': 'Active',
      'System.WorkItemType': 'Bug',
      'System.TeamProject': 'Web',
      'System.ChangedDate': `2026-11-0${id}T10:00:00.000Z`,
      'System.Description': '<div>Broken <b>login</b>&nbsp;page</div>',
      'System.AssignedTo': { displayName: 'Grace', uniqueName: 'grace@example.com' },
      ...extra,
    },
    url: `https://dev.azure.com/acme/p-guid/_apis/wit/workItems/${id}`,
  };
}

const workItemTypes = {
  value: [
    {
      name: 'Bug',
      states: [
        { name: 'New', category: 'Proposed' },
        { name: 'Active', category: 'InProgress' },
        { name: 'Shipped', category: 'Completed' },
        { name: 'Removed', category: 'Removed' },
      ],
    },
  ],
};

function stubFetch(routes: FakeRoute[]) {
  const fake = createFakeFetch(routes);
  vi.stubGlobal('fetch', fake.fetch);
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('azure devops work item helpers', () => {
  it('derives closed states from work item type categories', () => {
    expect([...closedStateNames(workItemTypes.value)]).toEqual(['shipped', 'removed']);
    expect(closedStateNames([])).toBe(STOCK_CLOSED_STATES);
  });

  it('builds a WIQL query with escaped literals', () => {
    expect(
      buildWorkItemQuery({
        project: "Bob's",
        closedStates: new Set(['done']),
        searchTerm: "it's #5",
      })
    ).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Bob''s' AND [System.State] NOT IN ('done') AND ([System.Title] CONTAINS 'it''s #5') ORDER BY [System.ChangedDate] DESC, [System.Id] DESC"
    );
    expect(
      buildWorkItemQuery({ project: 'Web', closedStates: new Set(['done']), searchTerm: '#5' })
    ).toContain("([System.Title] CONTAINS '#5' OR [System.Id] = 5)");
  });

  it('converts HTML descriptions to text', () => {
    expect(htmlToText('<p>One&amp;two</p><ul><li>a</li><li>b</li></ul>x<br/>y &#39;z&#x27;')).toBe(
      "One&two\n- a\n- b\nx\ny 'z'"
    );
  });
});

describe('azure devops issues plugin', () => {
  it('lists open work items for the remote project in WIQL order', async () => {
    const fake = stubFetch([
      { match: '/acme/Web/_apis/wit/workitemtypes', body: workItemTypes },
      {
        method: 'POST',
        match: '/acme/Web/_apis/wit/wiql',
        body: { workItems: [{ id: 2 }, { id: 1 }] },
      },
      {
        method: 'POST',
        match: '/acme/_apis/wit/workitemsbatch',
        body: { count: 2, value: [workItem(1), workItem(2)] },
      },
    ]);
    const result = await issues.listIssues(makeHost(), {
      repositoryUrl: 'https://ssh.dev.azure.com/v3/acme/Web/api',
      limit: 25,
    });
    expect(result).toEqual({
      success: true,
      data: [
        {
          identifier: '#2',
          title: 'Work item 2',
          url: 'https://dev.azure.com/acme/Web/_workitems/edit/2',
          description: 'Broken login page',
          status: 'Active',
          assignees: ['Grace'],
          project: 'Web',
          updatedAt: '2026-11-02T10:00:00.000Z',
        },
        expect.objectContaining({ identifier: '#1' }),
      ],
    });
    const wiql = fake.calls.find((call) => call.url.pathname.endsWith('/wiql'));
    expect(wiql?.url.searchParams.get('$top')).toBe('25');
    expect((wiql?.body as { query: string } | undefined)?.query).toContain(
      "[System.State] NOT IN ('shipped', 'removed')"
    );
    const batch = fake.calls.find((call) => call.url.pathname.endsWith('/workitemsbatch'));
    expect((batch?.body as { ids: number[] } | undefined)?.ids).toEqual([2, 1]);
    for (const call of fake.calls) {
      expect(call.url.origin).toBe('https://dev.azure.com');
      expect(call.headers.authorization).toBe(
        `Basic ${Buffer.from(':secret-pat').toString('base64')}`
      );
    }
  });

  it('returns an empty list without a batch read when nothing matches', async () => {
    const fake = stubFetch([
      { match: '/acme/Web/_apis/wit/workitemtypes', status: 500, body: {} },
      { method: 'POST', match: '/acme/Web/_apis/wit/wiql', body: { workItems: [] } },
    ]);
    expect(
      await issues.searchIssues(makeHost(), {
        repositoryUrl: REPO_URL,
        searchTerm: 'nothing',
        limit: 5,
      })
    ).toEqual({ success: true, data: [] });
    // Tür okuması başarısız olunca hazır kapalı durumlar kullanılır.
    expect((fake.calls[1].body as { query: string }).query).toContain("'closed', 'done'");
  });

  it('returns work item context with comments', async () => {
    stubFetch([
      {
        match: '/acme/Web/_apis/wit/workItems/7/comments',
        body: {
          totalCount: 1,
          comments: [
            {
              text: '<p>Repro on prod</p>',
              createdBy: { displayName: 'Grace' },
              createdDate: '2026-11-05',
            },
          ],
        },
      },
      {
        match: '/acme/Web/_apis/wit/workitems/7',
        body: {
          ...workItem(7, {
            'System.Tags': 'auth; ui',
            'System.CreatedBy': 'Ada <ada@example.com>',
          }),
          _links: { html: { href: 'https://dev.azure.com/acme/p-guid/_workitems/edit/7' } },
        },
      },
    ]);
    const result = await issues.getIssue?.(makeHost(), {
      identifier: '7',
      repositoryUrl: REPO_URL,
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        identifier: '#7',
        url: 'https://dev.azure.com/acme/p-guid/_workitems/edit/7',
        context:
          'Type: Bug\nTags: auth; ui\nCreated by: Ada <ada@example.com>\n\nComments:\n- Grace (2026-11-05): Repro on prod',
      },
    });
  });

  it('maps an invalid PAT sign-in page to an auth error', async () => {
    stubFetch([
      { match: '/acme/Web/_apis/wit/workitemtypes', status: 203, text: '<html>Sign in</html>' },
      { match: '/acme/Web/_apis/wit/wiql', status: 203, text: '<html>Sign in</html>' },
    ]);
    const result = await issues.listIssues(makeHost(), { repositoryUrl: REPO_URL, limit: 5 });
    expect(result).toEqual({
      success: false,
      error: {
        type: 'auth_failed',
        message: 'Azure DevOps authentication failed. Check your credentials.',
      },
    });
  });

  it('never sends the PAT to a repository of another organization', async () => {
    const fake = stubFetch([]);
    expect(
      await issues.listIssues(makeHost('https://dev.azure.com/other'), {
        repositoryUrl: REPO_URL,
        limit: 5,
      })
    ).toMatchObject({ success: false, error: { type: 'unsupported_host' } });
    expect(fake.calls).toHaveLength(0);
  });
});
