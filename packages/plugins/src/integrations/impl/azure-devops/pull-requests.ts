// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/source-control-azure-devops/src/server/azureDevOpsPullRequestJson.ts, packages/source-control-azure-devops/src/server/AzureDevOpsPullRequestCli.ts, packages/source-control-azure-devops/src/server/azureDevOpsPullRequests.ts
import { err, ok, type Result } from '@orkestra/shared';
import z from 'zod';
import {
  type ForgeActor,
  type ForgeCheck,
  type ForgeCheckStatus,
  type ForgeComment,
  type ForgeCreatePullRequestInput,
  type ForgeMergeability,
  type ForgeMergeInput,
  type ForgeMergeMethod,
  type ForgePullRequest,
  type ForgePullRequestState,
  type ForgePullRequestStateFilter,
  trimmedOrNull,
} from '../../helpers/forge-pull-requests';
import type { HttpClient, HttpClientError } from '../../helpers/http-client';
import { AZURE_DEVOPS_API_VERSION } from './client';
import type { AzureDevOpsRepository } from './remote';

/**
 * Azure DevOps Services pull request işlemleri REST API ile (T3 aynı eşlemeleri `az` CLI
 * çıktısı üzerinde yapar). Durum, birleştirilebilirlik ve ilke (policy) kontrolleri T3'ün
 * eşlemesini izler.
 */

const identitySchema = z.object({
  displayName: z.string().nullish(),
  uniqueName: z.string().nullish(),
  imageUrl: z.string().nullish(),
});

const pullRequestSchema = z.object({
  pullRequestId: z.number().int(),
  title: z.string(),
  description: z.string().nullish(),
  status: z.string().nullish(),
  isDraft: z.boolean().nullish(),
  mergeStatus: z.string().nullish(),
  createdBy: identitySchema.nullish(),
  reviewers: z.array(identitySchema).nullish(),
  sourceRefName: z.string().trim().min(1),
  targetRefName: z.string().trim().min(1),
  creationDate: z.string().trim().min(1),
  closedDate: z.string().nullish(),
  lastMergeSourceCommit: z.object({ commitId: z.string().nullish() }).nullish(),
  lastMergeTargetCommit: z.object({ commitId: z.string().nullish() }).nullish(),
  repository: z
    .object({
      name: z.string().nullish(),
      webUrl: z.string().nullish(),
      project: z.object({ id: z.string().nullish(), name: z.string().nullish() }).nullish(),
    })
    .nullish(),
});

type RawPullRequest = z.infer<typeof pullRequestSchema>;

const listSchema = z.object({ value: z.array(z.unknown()) });

const policyEvaluationSchema = z.object({
  status: z.string(),
  context: z
    .object({
      buildId: z.number().int().nullish(),
      buildDefinitionName: z.string().nullish(),
      isExpired: z.boolean().nullish(),
    })
    .nullish(),
  configuration: z.object({
    url: z.string().nullish(),
    isBlocking: z.boolean().nullish(),
    isEnabled: z.boolean().nullish(),
    isDeleted: z.boolean().nullish(),
    type: z.object({ id: z.string(), displayName: z.string().nullish() }),
    settings: z
      .object({
        displayName: z.string().nullish(),
        defaultDisplayName: z.string().nullish(),
        statusName: z.string().nullish(),
        manualQueueOnly: z.boolean().nullish(),
      })
      .nullish(),
  }),
});

type RawPolicyEvaluation = z.infer<typeof policyEvaluationSchema>;

const statusSchema = z.object({
  id: z.number().int().nullish(),
  state: z.string().nullish(),
  description: z.string().nullish(),
  targetUrl: z.string().nullish(),
  context: z.object({ name: z.string().nullish(), genre: z.string().nullish() }).nullish(),
});

const threadSchema = z.object({
  id: z.number().int(),
  isDeleted: z.boolean().nullish(),
  threadContext: z.object({ filePath: z.string().nullish() }).nullish(),
  comments: z
    .array(
      z.object({
        id: z.number().int().nullish(),
        content: z.string().nullish(),
        author: identitySchema.nullish(),
        publishedDate: z.string().nullish(),
        isDeleted: z.boolean().nullish(),
        commentType: z.union([z.string(), z.number()]).nullish(),
      })
    )
    .nullish(),
});

const BUILD_POLICY_TYPE = '0609b952-1397-4640-95ec-e00a01b2c241';
const STATUS_POLICY_TYPE = 'cbdc66da-9728-4af8-aada-9a5a32e4a226';
// Diğer ilke türleri insanları bekler ya da push'u kısıtlar; bitmeyen kontroller gibi görünürlerdi.
const CHECK_POLICY_TYPES = new Set([BUILD_POLICY_TYPE, STATUS_POLICY_TYPE]);

export function toAzureDevOpsStatusFilter(state: ForgePullRequestStateFilter): string {
  switch (state) {
    case 'open':
      return 'active';
    case 'merged':
      return 'completed';
    case 'closed':
      return 'abandoned';
    case 'all':
      return 'all';
  }
}

export function toAzureDevOpsPullRequestState(
  value: string | null | undefined
): ForgePullRequestState {
  switch (value?.trim().toLowerCase()) {
    case 'completed':
      return 'merged';
    case 'abandoned':
      return 'closed';
    default:
      return 'open';
  }
}

export function toAzureDevOpsMergeability(value: string | null | undefined): ForgeMergeability {
  switch (value?.trim().toLowerCase()) {
    case 'succeeded':
      return 'mergeable';
    case 'conflicts':
    case 'failure':
    case 'rejectedbypolicy':
      return 'conflicting';
    default:
      return 'unknown';
  }
}

export function toAzureDevOpsMergeStrategy(method: ForgeMergeMethod | undefined): string {
  switch (method) {
    case 'squash':
      return 'squash';
    case 'rebase':
      return 'rebase';
    default:
      return 'noFastForward';
  }
}

/** PR durum (status) API'sinin durumları. */
export function toAzureDevOpsStatusState(value: string | null | undefined): ForgeCheckStatus {
  switch (value?.trim().toLowerCase()) {
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'error':
      return 'failure';
    case 'pending':
      return 'pending';
    case 'notapplicable':
      return 'skipped';
    default:
      return 'neutral';
  }
}

/** Azure, kendiliğinden hiç başlamayacak bir derlemeyi de `queued` bildirir; bunları ayırırız. */
function toPolicyCheckProgress(
  raw: RawPolicyEvaluation
): Pick<ForgeCheck, 'status' | 'description'> {
  const settled = (status: ForgeCheckStatus) => ({ status, description: null });
  switch (raw.status.trim().toLowerCase()) {
    case 'approved':
      return settled('success');
    case 'rejected':
    case 'broken':
      return settled('failure');
    case 'running':
      return settled('pending');
    case 'notapplicable':
      return settled('skipped');
    case 'queued':
      break;
    default:
      // Yerleşmiş her durum geçti sayılabileceğinden bilinmeyen durum geçmiş sayılmaz.
      return settled('pending');
  }
  const expired = raw.context?.isExpired === true;
  if (!expired && raw.configuration.settings?.manualQueueOnly !== true) return settled('pending');
  // Yalnızca engelleyici derleme PR'ı tutar; kimsenin kuyruğa almadığı isteğe bağlı derleme hiç çalışmaz.
  return {
    status: raw.configuration.isBlocking === true ? 'action-required' : 'skipped',
    description: expired ? 'Expired. Queue it again on Azure DevOps.' : 'Queue it on Azure DevOps.',
  };
}

function toPolicyCheckUrl(raw: RawPolicyEvaluation): string | null {
  const buildId = raw.context?.buildId;
  const [projectUrl, rest] = (raw.configuration.url ?? '').split('/_apis/', 2);
  return buildId == null || rest === undefined
    ? null
    : `${projectUrl}/_build/results?buildId=${buildId}`;
}

export function toAzureDevOpsPolicyCheck(
  raw: RawPolicyEvaluation,
  isDraft: boolean
): ForgeCheck | null {
  const { configuration, context } = raw;
  if (
    !CHECK_POLICY_TYPES.has(configuration.type.id.toLowerCase()) ||
    configuration.isEnabled === false ||
    configuration.isDeleted === true
  ) {
    return null;
  }
  // Taslakta Azure'un bekletip hiç başlatmayacağı derleme dışarıda kalır.
  if (isDraft && raw.status.trim().toLowerCase() === 'queued' && context?.buildId == null) {
    return null;
  }
  return {
    name:
      trimmedOrNull(configuration.settings?.displayName) ??
      trimmedOrNull(configuration.settings?.defaultDisplayName) ??
      trimmedOrNull(context?.buildDefinitionName) ??
      trimmedOrNull(configuration.settings?.statusName) ??
      trimmedOrNull(configuration.type.displayName) ??
      'Policy',
    ...toPolicyCheckProgress(raw),
    url: toPolicyCheckUrl(raw),
    required: configuration.isBlocking === true,
  };
}

function toActor(raw: z.infer<typeof identitySchema> | null | undefined): ForgeActor | null {
  const login = trimmedOrNull(raw?.uniqueName) ?? trimmedOrNull(raw?.displayName);
  return login === null
    ? null
    : {
        login,
        name: trimmedOrNull(raw?.displayName),
        avatarUrl: trimmedOrNull(raw?.imageUrl),
      };
}

function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

function toRef(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

function repositoryPath(repository: AzureDevOpsRepository): string {
  return `/${encodeURIComponent(repository.project)}/_apis/git/repositories/${encodeURIComponent(repository.repository)}`;
}

const query = (extra: Record<string, string | number | boolean | undefined> = {}) => ({
  ...extra,
  'api-version': AZURE_DEVOPS_API_VERSION,
});

export function azureDevOpsPullRequestWebUrl(
  repository: AzureDevOpsRepository,
  raw: Pick<RawPullRequest, 'pullRequestId' | 'repository'>
): string {
  const base = trimmedOrNull(raw.repository?.webUrl) ?? repository.webUrl;
  return `${base.replace(/\/+$/, '')}/pullrequest/${raw.pullRequestId}`;
}

function toPullRequest(repository: AzureDevOpsRepository, raw: RawPullRequest): ForgePullRequest {
  const closedAt = trimmedOrNull(raw.closedDate);
  return {
    number: raw.pullRequestId,
    title: raw.title,
    url: azureDevOpsPullRequestWebUrl(repository, raw),
    body: raw.description ?? '',
    state: toAzureDevOpsPullRequestState(raw.status),
    isDraft: raw.isDraft ?? false,
    author: toActor(raw.createdBy),
    headBranch: branchName(raw.sourceRefName),
    headSha: trimmedOrNull(raw.lastMergeSourceCommit?.commitId),
    baseBranch: branchName(raw.targetRefName),
    baseSha: trimmedOrNull(raw.lastMergeTargetCommit?.commitId),
    mergeability: toAzureDevOpsMergeability(raw.mergeStatus),
    createdAt: raw.creationDate,
    updatedAt: closedAt ?? raw.creationDate,
    closedAt,
    reviewers: (raw.reviewers ?? []).flatMap((reviewer) => toActor(reviewer) ?? []),
  };
}

function decodeRawPullRequest(body: unknown): Result<RawPullRequest, HttpClientError> {
  const parsed = pullRequestSchema.safeParse(body);
  return parsed.success
    ? ok(parsed.data)
    : err({ type: 'generic', message: 'Azure DevOps returned an unexpected pull request.' });
}

function decodeList(body: unknown): Result<unknown[], HttpClientError> {
  const parsed = listSchema.safeParse(body);
  return parsed.success
    ? ok(parsed.data.value)
    : err({ type: 'generic', message: 'Azure DevOps returned an unexpected list.' });
}

export async function listAzureDevOpsPullRequests(
  client: HttpClient,
  repository: AzureDevOpsRepository,
  input: { state?: ForgePullRequestStateFilter; sourceBranch?: string; limit?: number } = {}
): Promise<Result<ForgePullRequest[], HttpClientError>> {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const response = await client.request({
    path: `${repositoryPath(repository)}/pullrequests`,
    query: query({
      'searchCriteria.status': toAzureDevOpsStatusFilter(input.state ?? 'open'),
      ...(input.sourceBranch ? { 'searchCriteria.sourceRefName': toRef(input.sourceBranch) } : {}),
      $top: limit,
    }),
  });
  if (!response.success) return response;
  const values = decodeList(response.data.body);
  if (!values.success) return values;
  return ok(
    values.data.flatMap((entry) => {
      const parsed = pullRequestSchema.safeParse(entry);
      return parsed.success ? [toPullRequest(repository, parsed.data)] : [];
    })
  );
}

async function getRawPullRequest(
  client: HttpClient,
  repository: AzureDevOpsRepository,
  number: number
): Promise<Result<RawPullRequest, HttpClientError>> {
  const response = await client.request({
    path: `${repositoryPath(repository)}/pullrequests/${number}`,
    query: query(),
  });
  if (!response.success) return response;
  return decodeRawPullRequest(response.data.body);
}

export async function getAzureDevOpsPullRequest(
  client: HttpClient,
  repository: AzureDevOpsRepository,
  number: number
): Promise<Result<ForgePullRequest, HttpClientError>> {
  const raw = await getRawPullRequest(client, repository, number);
  return raw.success ? ok(toPullRequest(repository, raw.data)) : raw;
}

export async function createAzureDevOpsPullRequest(
  client: HttpClient,
  repository: AzureDevOpsRepository,
  input: ForgeCreatePullRequestInput
): Promise<Result<ForgePullRequest, HttpClientError>> {
  const response = await client.request({
    method: 'POST',
    path: `${repositoryPath(repository)}/pullrequests`,
    query: query(),
    body: {
      sourceRefName: toRef(input.sourceBranch),
      targetRefName: toRef(input.targetBranch),
      title: input.title,
      description: input.description,
      isDraft: input.isDraft === true,
    },
  });
  if (!response.success) return response;
  const raw = decodeRawPullRequest(response.data.body);
  return raw.success ? ok(toPullRequest(repository, raw.data)) : raw;
}

/**
 * Derleme/durum ilkeleri (policy evaluations) ve harici PR durumları. İlke değerlendirmesi
 * projenin kimliğini (GUID) ister; PR ayrıntısından okunur.
 */
export async function listAzureDevOpsPullRequestChecks(
  client: HttpClient,
  repository: AzureDevOpsRepository,
  number: number
): Promise<Result<ForgeCheck[], HttpClientError>> {
  const raw = await getRawPullRequest(client, repository, number);
  if (!raw.success) return raw;
  const projectId = trimmedOrNull(raw.data.repository?.project?.id);
  const isDraft = raw.data.isDraft === true;

  const [policies, statuses] = await Promise.all([
    projectId
      ? client.request({
          path: `/${encodeURIComponent(repository.project)}/_apis/policy/evaluations`,
          query: {
            artifactId: `vstfs:///CodeReview/CodeReviewId/${projectId}/${number}`,
            'api-version': `${AZURE_DEVOPS_API_VERSION}-preview.1`,
          },
        })
      : Promise.resolve(null),
    client.request({
      path: `${repositoryPath(repository)}/pullRequests/${number}/statuses`,
      query: query(),
    }),
  ]);

  const checks: ForgeCheck[] = [];
  if (policies) {
    if (!policies.success) return policies;
    const values = decodeList(policies.data.body);
    if (!values.success) return values;
    for (const entry of values.data) {
      const parsed = policyEvaluationSchema.safeParse(entry);
      const check = parsed.success ? toAzureDevOpsPolicyCheck(parsed.data, isDraft) : null;
      if (check) checks.push(check);
    }
  }
  if (!statuses.success) return statuses;
  const statusValues = decodeList(statuses.data.body);
  if (!statusValues.success) return statusValues;
  // Aynı bağlam için en yeni durum (en yüksek kimlik) kazanır.
  const latest = new Map<string, z.infer<typeof statusSchema>>();
  for (const entry of statusValues.data) {
    const parsed = statusSchema.safeParse(entry);
    if (!parsed.success) continue;
    const name = [parsed.data.context?.genre, parsed.data.context?.name]
      .map((part) => trimmedOrNull(part))
      .filter(Boolean)
      .join('/');
    if (!name) continue;
    const previous = latest.get(name);
    if (!previous || (parsed.data.id ?? 0) >= (previous.id ?? 0)) latest.set(name, parsed.data);
  }
  for (const [name, status] of latest) {
    checks.push({
      name,
      status: toAzureDevOpsStatusState(status.state),
      description: trimmedOrNull(status.description),
      url: trimmedOrNull(status.targetUrl),
    });
  }
  return ok(checks);
}

function isSystemComment(type: string | number | null | undefined): boolean {
  return type === 'system' || type === 3 || type === 'codeChange' || type === 2;
}

export async function listAzureDevOpsPullRequestComments(
  client: HttpClient,
  repository: AzureDevOpsRepository,
  number: number
): Promise<Result<ForgeComment[], HttpClientError>> {
  const response = await client.request({
    path: `${repositoryPath(repository)}/pullRequests/${number}/threads`,
    query: query(),
  });
  if (!response.success) return response;
  const values = decodeList(response.data.body);
  if (!values.success) return values;
  const comments: ForgeComment[] = [];
  for (const entry of values.data) {
    const thread = threadSchema.safeParse(entry);
    if (!thread.success || thread.data.isDeleted) continue;
    const path = trimmedOrNull(thread.data.threadContext?.filePath);
    for (const comment of thread.data.comments ?? []) {
      const body = comment.content ?? '';
      if (comment.isDeleted || isSystemComment(comment.commentType) || !body.trim()) continue;
      comments.push({
        id: `${thread.data.id}:${comment.id ?? comments.length}`,
        author: toActor(comment.author),
        body,
        createdAt: comment.publishedDate ?? '',
        url: `${repository.webUrl}/pullrequest/${number}?discussionId=${thread.data.id}`,
        path,
      });
    }
  }
  return ok(comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
}

export async function addAzureDevOpsPullRequestComment(
  client: HttpClient,
  repository: AzureDevOpsRepository,
  number: number,
  body: string
): Promise<Result<ForgeComment, HttpClientError>> {
  const response = await client.request({
    method: 'POST',
    path: `${repositoryPath(repository)}/pullRequests/${number}/threads`,
    query: query(),
    // status 1 = active; commentType 1 = text
    body: { comments: [{ parentCommentId: 0, content: body, commentType: 1 }], status: 1 },
  });
  if (!response.success) return response;
  const thread = threadSchema.safeParse(response.data.body);
  if (!thread.success) {
    return err({ type: 'generic', message: 'Azure DevOps returned an unexpected comment.' });
  }
  const comment = thread.data.comments?.[0];
  return ok({
    id: `${thread.data.id}:${comment?.id ?? 1}`,
    author: toActor(comment?.author),
    body: comment?.content ?? body,
    createdAt: comment?.publishedDate ?? '',
    url: `${repository.webUrl}/pullrequest/${number}?discussionId=${thread.data.id}`,
    path: null,
  });
}

/**
 * Tamamlama (merge) `lastMergeSourceCommit` ister; Azure bu commit artık baş değilse reddeder.
 * Böylece okunan baştan sonra gelen push'lar yanlışlıkla birleştirilmez.
 */
export async function mergeAzureDevOpsPullRequest(
  client: HttpClient,
  repository: AzureDevOpsRepository,
  input: ForgeMergeInput
): Promise<Result<ForgePullRequest, HttpClientError>> {
  const current = await getRawPullRequest(client, repository, input.number);
  if (!current.success) return current;
  const head = trimmedOrNull(current.data.lastMergeSourceCommit?.commitId);
  if (!head) {
    return err({ type: 'generic', message: 'Azure DevOps did not report the pull request head.' });
  }
  if (input.expectedHeadSha && input.expectedHeadSha.toLowerCase() !== head.toLowerCase()) {
    return err({
      type: 'invalid_input',
      message: 'The pull request has new commits. Reload it before merging.',
    });
  }
  const response = await client.request({
    method: 'PATCH',
    path: `${repositoryPath(repository)}/pullrequests/${input.number}`,
    query: query(),
    body: {
      status: 'completed',
      lastMergeSourceCommit: { commitId: head },
      completionOptions: {
        mergeStrategy: toAzureDevOpsMergeStrategy(input.method),
        ...(input.deleteSourceBranch === undefined
          ? {}
          : { deleteSourceBranch: input.deleteSourceBranch }),
      },
    },
  });
  if (!response.success) return response;
  const raw = decodeRawPullRequest(response.data.body);
  return raw.success ? ok(toPullRequest(repository, raw.data)) : raw;
}
