// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/source-control-azure-devops/src/server/AzureDevOpsIssueTracker.ts
import { err, ok, type Result } from '@orkestra/shared';
import z from 'zod';
import type { HttpClient, HttpClientError } from '../../../integrations/helpers/http-client';
import type { ConnectedIntegrationHostContext } from '../../../integrations/host';
import {
  AZURE_DEVOPS_API_VERSION,
  createAzureDevOpsClient,
  readAzureDevOpsCredentials,
} from '../../../integrations/impl/azure-devops/client';
import {
  type AzureDevOpsRepository,
  resolveAzureDevOpsRepository,
} from '../../../integrations/impl/azure-devops/remote';
import {
  type AzureDevOpsWorkItem,
  azureDevOpsWorkItemSchema,
} from '../../../integrations/impl/azure-devops/types';
import type { IntegrationError } from '../../../integrations/types';
import { clampIssueLimit, normalizeSearchTerm } from '../../helpers/provider-inputs';
import { defineIssuesPlugin, registerIssuesPluginBehavior } from '../../plugin';
import type {
  IssueData,
  IssueGetOpts,
  IssueGetResult,
  IssueListResult,
  IssueQueryOpts,
  IssueSearchOpts,
} from '../../types';
import {
  closedStateNames,
  identityName,
  STOCK_CLOSED_STATES,
  toIssueData,
  toIssueDetail,
} from './mapper';

/**
 * Azure Boards iş öğeleri. İş öğeleri projeye aittir: remote'un `{org}/{project}/_git/{repo}`
 * yolundan proje alınır. Listeleme bir WIQL sorgusu + toplu iş öğesi okumasıdır.
 */

type Connected = { client: HttpClient; repository: AzureDevOpsRepository };

const LIST_FIELDS = [
  'System.Id',
  'System.Title',
  'System.State',
  'System.WorkItemType',
  'System.TeamProject',
  'System.ChangedDate',
  'System.CreatedDate',
  'System.Description',
  'Microsoft.VSTS.TCM.ReproSteps',
  'System.AssignedTo',
];

const wiqlSchema = z.object({
  workItems: z.array(z.object({ id: z.number().int() })).nullish(),
});

const listSchema = z.object({ value: z.array(z.unknown()) });

const workItemTypesSchema = z.object({
  value: z.array(
    z.object({
      name: z.string(),
      states: z.array(z.object({ name: z.string(), category: z.string() })).nullish(),
    })
  ),
});

const commentsSchema = z.object({
  comments: z
    .array(
      z.object({
        text: z.string().nullish(),
        createdDate: z.string().nullish(),
        createdBy: z.object({ displayName: z.string().nullish() }).nullish(),
      })
    )
    .nullish(),
});

function connect(
  host: ConnectedIntegrationHostContext,
  repositoryUrl: string | undefined
): Result<Connected, IntegrationError> {
  const credentials = readAzureDevOpsCredentials(host.credentials);
  if (!credentials.success) return err(credentials.error);
  const repository = resolveAzureDevOpsRepository(repositoryUrl, credentials.data.organizationUrl);
  if (!repository.success) return err(repository.error);
  const client = createAzureDevOpsClient(credentials.data);
  if (!client.success) return err(client.error);
  return ok({ client: client.data, repository: repository.data });
}

function publicError(error: HttpClientError): IntegrationError {
  const { status: _status, ...rest } = error;
  return rest as IntegrationError;
}

/** WIQL dize değişmezleri tek tırnaklıdır; tırnak iki kez yazılarak kaçırılır. */
export function wiqlQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildWorkItemQuery(input: {
  project: string;
  closedStates: ReadonlySet<string>;
  searchTerm?: string;
}): string {
  const closed = `(${[...input.closedStates].map(wiqlQuoted).join(', ')})`;
  const numeric = input.searchTerm ? /^#?(\d{1,10})$/.exec(input.searchTerm)?.[1] : undefined;
  const search = input.searchTerm
    ? ` AND ([System.Title] CONTAINS ${wiqlQuoted(input.searchTerm)}${
        numeric ? ` OR [System.Id] = ${numeric}` : ''
      })`
    : '';
  return (
    `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = ${wiqlQuoted(input.project)}` +
    ` AND [System.State] NOT IN ${closed}${search}` +
    ' ORDER BY [System.ChangedDate] DESC, [System.Id] DESC'
  );
}

async function readClosedStates(connected: Connected): Promise<ReadonlySet<string>> {
  const response = await connected.client.request({
    path: `/${encodeURIComponent(connected.repository.project)}/_apis/wit/workitemtypes`,
    query: { 'api-version': AZURE_DEVOPS_API_VERSION },
  });
  if (!response.success) return STOCK_CLOSED_STATES;
  const parsed = workItemTypesSchema.safeParse(response.data.body);
  return parsed.success ? closedStateNames(parsed.data.value) : STOCK_CLOSED_STATES;
}

async function queryWorkItems(
  connected: Connected,
  limit: number,
  searchTerm?: string
): Promise<Result<IssueData[], HttpClientError>> {
  const closedStates = await readClosedStates(connected);
  const { project, organizationUrl } = connected.repository;
  const wiql = await connected.client.request({
    method: 'POST',
    path: `/${encodeURIComponent(project)}/_apis/wit/wiql`,
    query: { $top: limit, 'api-version': AZURE_DEVOPS_API_VERSION },
    body: { query: buildWorkItemQuery({ project, closedStates, searchTerm }) },
  });
  if (!wiql.success) return wiql;
  const ids = (wiqlSchema.safeParse(wiql.data.body).data?.workItems ?? [])
    .map((item) => item.id)
    .slice(0, limit);
  if (ids.length === 0) return ok([]);

  const batch = await connected.client.request({
    method: 'POST',
    path: '/_apis/wit/workitemsbatch',
    query: { 'api-version': AZURE_DEVOPS_API_VERSION },
    body: { ids, fields: LIST_FIELDS, errorPolicy: 'omit' },
  });
  if (!batch.success) return batch;
  const values = listSchema.safeParse(batch.data.body);
  if (!values.success) {
    return err({ type: 'generic', message: 'Azure DevOps returned an unexpected work item list.' });
  }
  const byId = new Map<number, AzureDevOpsWorkItem>();
  for (const entry of values.data.value) {
    const parsed = azureDevOpsWorkItemSchema.safeParse(entry);
    if (parsed.success) byId.set(parsed.data.id, parsed.data);
  }
  // WIQL sırası (son güncellenen önce) korunur.
  return ok(
    ids.flatMap((id) => {
      const item = byId.get(id);
      return item ? [toIssueData(item, { organizationUrl, project })] : [];
    })
  );
}

export async function listIssues(
  host: ConnectedIntegrationHostContext,
  opts: IssueQueryOpts
): Promise<IssueListResult> {
  const connected = connect(host, opts.repositoryUrl);
  if (!connected.success) return err(connected.error);
  const result = await queryWorkItems(connected.data, clampIssueLimit(opts.limit, 50, 200));
  if (!result.success) {
    host.log.warn('Azure DevOps listIssues failed', { type: result.error.type });
    return err(publicError(result.error));
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
  const result = await queryWorkItems(connected.data, clampIssueLimit(opts.limit, 20, 200), term);
  if (!result.success) {
    host.log.warn('Azure DevOps searchIssues failed', { type: result.error.type });
    return err(publicError(result.error));
  }
  return ok(result.data);
}

export async function getIssue(
  host: ConnectedIntegrationHostContext,
  opts: IssueGetOpts
): Promise<IssueGetResult> {
  const id = /^#?(\d{1,10})$/.exec(normalizeSearchTerm(opts.identifier))?.[1];
  if (!id) return err({ type: 'invalid_input', message: 'Azure DevOps work item ID is required.' });
  const connected = connect(host, opts.repositoryUrl);
  if (!connected.success) return err(connected.error);
  const { client, repository } = connected.data;
  const projectPath = `/${encodeURIComponent(repository.project)}`;

  const [item, comments] = await Promise.all([
    client.request({
      path: `${projectPath}/_apis/wit/workitems/${id}`,
      query: { $expand: 'links', 'api-version': AZURE_DEVOPS_API_VERSION },
    }),
    client.request({
      path: `${projectPath}/_apis/wit/workItems/${id}/comments`,
      query: { $top: 50, order: 'asc', 'api-version': `${AZURE_DEVOPS_API_VERSION}-preview.4` },
    }),
  ]);
  if (!item.success) {
    host.log.warn('Azure DevOps getIssue failed', { type: item.error.type });
    return err(publicError(item.error));
  }
  const parsed = azureDevOpsWorkItemSchema.safeParse(item.data.body);
  if (!parsed.success) {
    return err({ type: 'generic', message: 'Azure DevOps returned an unexpected work item.' });
  }
  // Yorumlar bağlamı zenginleştirir; okunamazlarsa iş öğesi yine döner.
  const parsedComments = comments.success
    ? (commentsSchema.safeParse(comments.data.body).data?.comments ?? []).map((comment) => ({
        author: identityName(comment.createdBy?.displayName),
        text: comment.text ?? '',
        createdAt: comment.createdDate ?? undefined,
      }))
    : [];

  return ok(
    toIssueDetail(
      parsed.data,
      { organizationUrl: repository.organizationUrl, project: repository.project },
      parsedComments
    )
  );
}

const plugin = defineIssuesPlugin(
  { integrationId: 'azure-devops' },
  { issues: { requiredInputs: ['repositoryUrl'] } },
  {}
);

export const provider = registerIssuesPluginBehavior(plugin, {
  issues: { listIssues, searchIssues, getIssue },
});
