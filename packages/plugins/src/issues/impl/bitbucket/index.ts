import { err, ok, type Result } from '@orkestra/shared';
import type { HttpClient, HttpClientError } from '../../../integrations/helpers/http-client';
import type { ConnectedIntegrationHostContext } from '../../../integrations/host';
import {
  createBitbucketClient,
  listBitbucketPages,
  readBitbucketCredentials,
} from '../../../integrations/impl/bitbucket/client';
import {
  type BitbucketCloudRepository,
  bitbucketRepositoryPath,
  resolveBitbucketCloudRepository,
} from '../../../integrations/impl/bitbucket/remote';
import {
  bitbucketIssueCommentSchema,
  bitbucketIssueSchema,
} from '../../../integrations/impl/bitbucket/types';
import type { IntegrationError } from '../../../integrations/types';
import { clampIssueLimit, normalizeSearchTerm } from '../../helpers/provider-inputs';
import { defineIssuesPlugin, registerIssuesPluginBehavior } from '../../plugin';
import type {
  IssueGetOpts,
  IssueGetResult,
  IssueListResult,
  IssueQueryOpts,
  IssueSearchOpts,
} from '../../types';
import {
  BITBUCKET_OPEN_ISSUE_STATES,
  bitbucketUserName,
  toIssueData,
  toIssueDetail,
} from './mapper';

type Connected = { client: HttpClient; repository: BitbucketCloudRepository };

function connect(
  host: ConnectedIntegrationHostContext,
  repositoryUrl: string | undefined
): Result<Connected, IntegrationError> {
  const credentials = readBitbucketCredentials(host.credentials);
  if (!credentials.success) return err(credentials.error);
  const repository = resolveBitbucketCloudRepository(repositoryUrl);
  if (!repository.success) return err(repository.error);
  const client = createBitbucketClient(credentials.data);
  if (!client.success) return err(client.error);
  return ok({ client: client.data, repository: repository.data });
}

/** Bitbucket sorgu dilinde dize değişmezi. */
function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

const OPEN_STATE_FILTER = `(${BITBUCKET_OPEN_ISSUE_STATES.map((state) => `state = ${quoted(state)}`).join(' OR ')})`;

/** Depoda iş takibi kapalıysa Bitbucket 404 döner; bunu açık bir mesaja çeviririz. */
function issueError(error: HttpClientError, fallback: string): IntegrationError {
  if (error.type === 'not_found_or_no_access') {
    return {
      type: 'not_found_or_no_access',
      message:
        'Bitbucket issues are not enabled for this repository, or you do not have access to them.',
    };
  }
  const { status: _status, ...rest } = error;
  return rest.message ? (rest as IntegrationError) : { type: 'generic', message: fallback };
}

async function queryIssues(
  connected: Connected,
  filter: string,
  limit: number
): Promise<Result<ReturnType<typeof toIssueData>[], HttpClientError>> {
  const values = await listBitbucketPages(
    connected.client,
    {
      path: `${bitbucketRepositoryPath(connected.repository)}/issues`,
      query: { q: filter, sort: '-updated_on', pagelen: Math.min(limit, 50) },
    },
    limit
  );
  if (!values.success) return values;
  return ok(
    values.data.flatMap((entry) => {
      const parsed = bitbucketIssueSchema.safeParse(entry);
      return parsed.success ? [toIssueData(parsed.data, connected.repository.repoSlug)] : [];
    })
  );
}

export async function listIssues(
  host: ConnectedIntegrationHostContext,
  opts: IssueQueryOpts
): Promise<IssueListResult> {
  const connected = connect(host, opts.repositoryUrl);
  if (!connected.success) return err(connected.error);
  const result = await queryIssues(
    connected.data,
    OPEN_STATE_FILTER,
    clampIssueLimit(opts.limit, 50, 100)
  );
  if (!result.success) {
    host.log.warn('Bitbucket listIssues failed', { type: result.error.type });
    return err(issueError(result.error, 'Unable to fetch Bitbucket issues.'));
  }
  return ok(result.data);
}

export async function searchIssues(
  host: ConnectedIntegrationHostContext,
  opts: IssueSearchOpts
): Promise<IssueListResult> {
  const term = normalizeSearchTerm(opts.searchTerm);
  if (!term) return ok([]);
  const connected = connect(host, opts.repositoryUrl);
  if (!connected.success) return err(connected.error);

  const numeric = /^#?(\d+)$/.exec(term)?.[1];
  const textFilter = `(title ~ ${quoted(term)} OR content.raw ~ ${quoted(term)}${
    numeric ? ` OR id = ${numeric}` : ''
  })`;
  const result = await queryIssues(
    connected.data,
    `${OPEN_STATE_FILTER} AND ${textFilter}`,
    clampIssueLimit(opts.limit, 20, 100)
  );
  if (!result.success) {
    host.log.warn('Bitbucket searchIssues failed', { type: result.error.type });
    return err(issueError(result.error, 'Unable to search Bitbucket issues.'));
  }
  return ok(result.data);
}

export async function getIssue(
  host: ConnectedIntegrationHostContext,
  opts: IssueGetOpts
): Promise<IssueGetResult> {
  const id = /^#?(\d+)$/.exec(normalizeSearchTerm(opts.identifier))?.[1];
  if (!id) {
    return err({ type: 'invalid_input', message: 'Bitbucket issue number is required.' });
  }
  const connected = connect(host, opts.repositoryUrl);
  if (!connected.success) return err(connected.error);
  const issuePath = `${bitbucketRepositoryPath(connected.data.repository)}/issues/${id}`;

  const response = await connected.data.client.request({ path: issuePath });
  if (!response.success) {
    host.log.warn('Bitbucket getIssue failed', { type: response.error.type });
    return err(issueError(response.error, 'Unable to fetch the Bitbucket issue.'));
  }
  const issue = bitbucketIssueSchema.safeParse(response.data.body);
  if (!issue.success) {
    return err({ type: 'generic', message: 'Bitbucket returned an unexpected issue.' });
  }

  // Yorumlar bağlamı zenginleştirir; okunamazlarsa iş yine döner.
  const comments = await listBitbucketPages(
    connected.data.client,
    { path: `${issuePath}/comments`, query: { pagelen: 50, sort: 'created_on' } },
    50
  );
  const parsedComments = comments.success
    ? comments.data.flatMap((entry) => {
        const parsed = bitbucketIssueCommentSchema.safeParse(entry);
        return parsed.success
          ? [
              {
                author: bitbucketUserName(parsed.data.user),
                body: parsed.data.content?.raw ?? '',
                createdAt: parsed.data.created_on ?? undefined,
              },
            ]
          : [];
      })
    : [];

  return ok(toIssueDetail(issue.data, connected.data.repository.repoSlug, parsedComments));
}

const plugin = defineIssuesPlugin(
  { integrationId: 'bitbucket' },
  { issues: { requiredInputs: ['repositoryUrl'] } },
  {}
);

export const provider = registerIssuesPluginBehavior(plugin, {
  issues: { listIssues, searchIssues, getIssue },
});
