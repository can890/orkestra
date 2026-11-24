// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/source-control-bitbucket/src/server/bitbucketPullRequestJson.ts, packages/source-control-bitbucket/src/server/BitbucketPullRequestApi.ts, packages/source-control-bitbucket/src/server/BitbucketApi.ts
import { err, ok, type Result } from '@orkestra/shared';
import z from 'zod';
import {
  dedupeChecksByKey,
  type ForgeActor,
  type ForgeCheck,
  type ForgeCheckStatus,
  type ForgeComment,
  type ForgeCreatePullRequestInput,
  type ForgeMergeInput,
  type ForgeMergeMethod,
  type ForgePullRequest,
  type ForgePullRequestState,
  type ForgePullRequestStateFilter,
  trimmedOrNull,
} from '../../helpers/forge-pull-requests';
import type { HttpClient, HttpClientError } from '../../helpers/http-client';
import { listBitbucketPages } from './client';
import { type BitbucketCloudRepository, bitbucketRepositoryPath } from './remote';
import { bitbucketUserSchema, type BitbucketUser } from './types';

/**
 * Bitbucket Cloud pull request işlemleri: listeleme, ayrıntı, oluşturma, derleme durumu
 * (statuses), yorumlar ve birleştirme. Bilinmeyen enum değerleri tüm yanıtı düşürmez;
 * okunamayan kayıtlar atlanır.
 */

const branchSchema = z.object({
  branch: z.object({ name: z.string().trim().min(1) }),
  commit: z.object({ hash: z.string().nullish() }).nullish(),
  repository: z.object({ full_name: z.string().nullish() }).nullish(),
});

const pullRequestSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string().nullish(),
  state: z.string().nullish(),
  draft: z.boolean().nullish(),
  author: bitbucketUserSchema.nullish(),
  source: branchSchema,
  destination: branchSchema,
  created_on: z.string(),
  updated_on: z.string(),
  closed_on: z.string().nullish(),
  reviewers: z.array(bitbucketUserSchema).nullish(),
  links: z.object({ html: z.object({ href: z.string().trim().min(1) }) }),
});

const statusSchema = z.object({
  key: z.string().nullish(),
  name: z.string().nullish(),
  state: z.string().nullish(),
  description: z.string().nullish(),
  url: z.string().nullish(),
});

const commentSchema = z.object({
  id: z.number().int(),
  content: z.object({ raw: z.string().nullish() }).nullish(),
  user: bitbucketUserSchema.nullish(),
  created_on: z.string(),
  deleted: z.boolean().nullish(),
  pending: z.boolean().nullish(),
  inline: z.object({ path: z.string().nullish() }).nullish(),
  links: z.object({ html: z.object({ href: z.string().nullish() }).nullish() }).nullish(),
});

const MAX_PAGE_SIZE = 50;

export function toBitbucketStates(state: ForgePullRequestStateFilter): string[] {
  switch (state) {
    case 'open':
      return ['OPEN'];
    case 'closed':
      return ['DECLINED', 'SUPERSEDED'];
    case 'merged':
      return ['MERGED'];
    case 'all':
      return ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'];
  }
}

export function toBitbucketPullRequestState(
  value: string | null | undefined
): ForgePullRequestState {
  switch (value?.trim().toUpperCase()) {
    case 'MERGED':
      return 'merged';
    case 'DECLINED':
    case 'SUPERSEDED':
      return 'closed';
    default:
      return 'open';
  }
}

export function toBitbucketBuildStatus(value: string | null | undefined): ForgeCheckStatus {
  switch (value?.trim().toUpperCase()) {
    case 'SUCCESSFUL':
      return 'success';
    case 'FAILED':
      return 'failure';
    case 'STOPPED':
      return 'cancelled';
    case 'INPROGRESS':
      return 'pending';
    default:
      return 'neutral';
  }
}

export function toBitbucketMergeStrategy(method: ForgeMergeMethod | undefined): string {
  switch (method) {
    case 'squash':
      return 'squash';
    case 'rebase':
      return 'rebase_fast_forward';
    default:
      return 'merge_commit';
  }
}

function toActor(raw: BitbucketUser | null | undefined): ForgeActor | null {
  const login = trimmedOrNull(raw?.nickname) ?? trimmedOrNull(raw?.display_name);
  return login === null
    ? null
    : {
        login,
        name: trimmedOrNull(raw?.display_name),
        avatarUrl: trimmedOrNull(raw?.links?.avatar?.href),
      };
}

function toPullRequest(raw: z.infer<typeof pullRequestSchema>): ForgePullRequest {
  return {
    number: raw.id,
    title: raw.title,
    url: raw.links.html.href,
    body: raw.description ?? '',
    state: toBitbucketPullRequestState(raw.state),
    isDraft: raw.draft ?? false,
    author: toActor(raw.author),
    headBranch: raw.source.branch.name,
    headSha: trimmedOrNull(raw.source.commit?.hash),
    baseBranch: raw.destination.branch.name,
    // Listeler çakışma durumunu içermez.
    mergeability: 'unknown',
    createdAt: raw.created_on,
    updatedAt: raw.updated_on,
    closedAt: trimmedOrNull(raw.closed_on),
    reviewers: (raw.reviewers ?? []).flatMap((reviewer) => toActor(reviewer) ?? []),
  };
}

function decodePullRequest(body: unknown): Result<ForgePullRequest, HttpClientError> {
  const parsed = pullRequestSchema.safeParse(body);
  return parsed.success
    ? ok(toPullRequest(parsed.data))
    : err({ type: 'generic', message: 'Bitbucket returned an unexpected pull request.' });
}

function quoteFilter(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export async function listBitbucketPullRequests(
  client: HttpClient,
  repository: BitbucketCloudRepository,
  input: { state?: ForgePullRequestStateFilter; sourceBranch?: string; limit?: number } = {}
): Promise<Result<ForgePullRequest[], HttpClientError>> {
  const states = toBitbucketStates(input.state ?? 'open');
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const filters = [
    states.length === 1
      ? `state = ${quoteFilter(states[0])}`
      : `(${states.map((state) => `state = ${quoteFilter(state)}`).join(' OR ')})`,
    ...(input.sourceBranch ? [`source.branch.name = ${quoteFilter(input.sourceBranch)}`] : []),
  ];
  const values = await listBitbucketPages(
    client,
    {
      path: `${bitbucketRepositoryPath(repository)}/pullrequests`,
      query: {
        state: states,
        pagelen: Math.min(limit, MAX_PAGE_SIZE),
        sort: '-updated_on',
        q: filters.join(' AND '),
      },
    },
    limit
  );
  if (!values.success) return values;
  return ok(
    values.data.flatMap((entry) => {
      const parsed = pullRequestSchema.safeParse(entry);
      return parsed.success ? [toPullRequest(parsed.data)] : [];
    })
  );
}

export async function getBitbucketPullRequest(
  client: HttpClient,
  repository: BitbucketCloudRepository,
  number: number
): Promise<Result<ForgePullRequest, HttpClientError>> {
  const response = await client.request({
    path: `${bitbucketRepositoryPath(repository)}/pullrequests/${number}`,
    query: { fields: '+closed_on' },
  });
  if (!response.success) return response;
  const pullRequest = decodePullRequest(response.data.body);
  if (!pullRequest.success || pullRequest.data.state !== 'open') return pullRequest;

  // Ayrıntıda çakışma durumu ayrı uç noktadan okunur; okunamazsa "bilinmiyor" kalır.
  const conflicts = await client.request({
    path: `${bitbucketRepositoryPath(repository)}/pullrequests/${number}/conflicts`,
  });
  if (conflicts.success) {
    const page = z.object({ values: z.array(z.unknown()) }).safeParse(conflicts.data.body);
    if (page.success) {
      pullRequest.data.mergeability = page.data.values.length === 0 ? 'mergeable' : 'conflicting';
    }
  }
  return pullRequest;
}

export async function createBitbucketPullRequest(
  client: HttpClient,
  repository: BitbucketCloudRepository,
  input: ForgeCreatePullRequestInput & { closeSourceBranch?: boolean }
): Promise<Result<ForgePullRequest, HttpClientError>> {
  const response = await client.request({
    method: 'POST',
    path: `${bitbucketRepositoryPath(repository)}/pullrequests`,
    body: {
      title: input.title,
      description: input.description,
      source: { branch: { name: input.sourceBranch } },
      destination: { branch: { name: input.targetBranch } },
      ...(input.closeSourceBranch === undefined
        ? {}
        : { close_source_branch: input.closeSourceBranch }),
      ...(input.isDraft ? { draft: true } : {}),
    },
  });
  if (!response.success) return response;
  return decodePullRequest(response.data.body);
}

/** Derleme durumları (Pipelines ve harici CI); aynı anahtarla yeniden çalışanlarda son kayıt kazanır. */
export async function listBitbucketPullRequestChecks(
  client: HttpClient,
  repository: BitbucketCloudRepository,
  number: number
): Promise<Result<ForgeCheck[], HttpClientError>> {
  const values = await listBitbucketPages(
    client,
    {
      path: `${bitbucketRepositoryPath(repository)}/pullrequests/${number}/statuses`,
      query: { pagelen: MAX_PAGE_SIZE },
    },
    200
  );
  if (!values.success) return values;
  const entries = values.data.flatMap((entry) => {
    const parsed = statusSchema.safeParse(entry);
    if (!parsed.success) return [];
    const name = trimmedOrNull(parsed.data.name) ?? trimmedOrNull(parsed.data.key);
    if (name === null) return [];
    return [
      {
        key: trimmedOrNull(parsed.data.key) ?? name,
        check: {
          name,
          status: toBitbucketBuildStatus(parsed.data.state),
          description: trimmedOrNull(parsed.data.description),
          url: trimmedOrNull(parsed.data.url),
        },
      },
    ];
  });
  return ok(dedupeChecksByKey(entries));
}

export async function listBitbucketPullRequestComments(
  client: HttpClient,
  repository: BitbucketCloudRepository,
  number: number,
  limit = 200
): Promise<Result<ForgeComment[], HttpClientError>> {
  const values = await listBitbucketPages(
    client,
    {
      path: `${bitbucketRepositoryPath(repository)}/pullrequests/${number}/comments`,
      query: { pagelen: MAX_PAGE_SIZE },
    },
    limit
  );
  if (!values.success) return values;
  return ok(
    values.data.flatMap((entry): ForgeComment[] => {
      const parsed = commentSchema.safeParse(entry);
      if (!parsed.success) return [];
      const comment = parsed.data;
      const body = comment.content?.raw ?? '';
      if (comment.deleted || comment.pending || body.trim().length === 0) return [];
      return [
        {
          id: String(comment.id),
          author: toActor(comment.user),
          body,
          createdAt: comment.created_on,
          url: trimmedOrNull(comment.links?.html?.href),
          path: trimmedOrNull(comment.inline?.path),
        },
      ];
    })
  );
}

export async function addBitbucketPullRequestComment(
  client: HttpClient,
  repository: BitbucketCloudRepository,
  number: number,
  body: string
): Promise<Result<ForgeComment, HttpClientError>> {
  const response = await client.request({
    method: 'POST',
    path: `${bitbucketRepositoryPath(repository)}/pullrequests/${number}/comments`,
    body: { content: { raw: body } },
  });
  if (!response.success) return response;
  const parsed = commentSchema.safeParse(response.data.body);
  if (!parsed.success) {
    return err({ type: 'generic', message: 'Bitbucket returned an unexpected comment.' });
  }
  return ok({
    id: String(parsed.data.id),
    author: toActor(parsed.data.user),
    body: parsed.data.content?.raw ?? body,
    createdAt: parsed.data.created_on,
    url: trimmedOrNull(parsed.data.links?.html?.href),
    path: trimmedOrNull(parsed.data.inline?.path),
  });
}

/**
 * Birleştirme yalnızca okunan baş commit üzerinde yapılır: araya yeni push girdiyse reddedilir.
 * Bitbucket PR yükünde commit karmaları kısaltılmış olabilir; önek karşılaştırılır.
 */
export async function mergeBitbucketPullRequest(
  client: HttpClient,
  repository: BitbucketCloudRepository,
  input: ForgeMergeInput
): Promise<Result<ForgePullRequest, HttpClientError>> {
  if (input.expectedHeadSha) {
    const current = await getBitbucketPullRequest(client, repository, input.number);
    if (!current.success) return current;
    const head = current.data.headSha?.toLowerCase() ?? '';
    const expected = input.expectedHeadSha.toLowerCase();
    if (!head || !(expected.startsWith(head) || head.startsWith(expected))) {
      return err({
        type: 'invalid_input',
        message: 'The pull request has new commits. Reload it before merging.',
      });
    }
  }
  const response = await client.request({
    method: 'POST',
    path: `${bitbucketRepositoryPath(repository)}/pullrequests/${input.number}/merge`,
    body: {
      merge_strategy: toBitbucketMergeStrategy(input.method),
      ...(input.deleteSourceBranch === undefined
        ? {}
        : { close_source_branch: input.deleteSourceBranch }),
    },
  });
  if (!response.success) return response;
  return decodePullRequest(response.data.body);
}
