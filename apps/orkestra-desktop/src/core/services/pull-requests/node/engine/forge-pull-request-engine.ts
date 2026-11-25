import {
  createAzureDevOpsClient,
  createAzureDevOpsPullRequest,
  createBitbucketClient,
  createBitbucketPullRequest,
  getAzureDevOpsPullRequest,
  getBitbucketPullRequest,
  listAzureDevOpsPullRequestChecks,
  listAzureDevOpsPullRequestComments,
  listAzureDevOpsPullRequestPage,
  listBitbucketPullRequestChecks,
  listBitbucketPullRequestComments,
  listBitbucketPullRequestPage,
  mergeAzureDevOpsPullRequest,
  mergeBitbucketPullRequest,
  readAzureDevOpsCredentials,
  readBitbucketCredentials,
  resolveAzureDevOpsRepository,
  resolveBitbucketCloudRepository,
  type AzureDevOpsRepository,
  type BitbucketCloudRepository,
  type FetchLike,
  type ForgeActor,
  type ForgeCheck,
  type ForgeComment,
  type ForgeCreatePullRequestInput,
  type ForgeMergeInput,
  type ForgePullRequest,
  type ForgePullRequestPage,
  type ForgePullRequestStateFilter,
  type HttpClient,
  type HttpClientError,
  type IntegrationError,
} from '@orkestra/plugins/integrations/forge';
import { err, ok, type Result } from '@orkestra/shared';
import type { ContractClient } from '@orkestra/wire/rpc';
import { parseForgeRepositoryRef, type ForgeProvider } from '@core/primitives/repository/api';
import {
  pullRequestProviderInfo,
  pullRequestUrlFor,
  type GitHubAuthContract,
  type GitHubAuthError,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestError,
  type PullRequestFile,
  type PullRequestMergeOptions,
  type PullRequestUser,
} from '../../api';
import { isAbortError, type PullRequestOperationErrorType } from './errors';
import type {
  GitHubPullRequestRepository,
  Observed,
  PullRequestMetadata,
  PullRequestPage,
} from './observation';
import type { PullRequestProviderEngine } from './provider-engine';

/**
 * Bir envanter ya da geçmiş taramasının izleyebileceği en çok sayfa (sayfa başına 50 PR, yani en
 * çok 2000 PR). Sınır aşılırsa tarama eksik envanteri "tam" diye bildirmek yerine hata verir;
 * o ana dek okunan sayfalar önbellekte kalır.
 */
export const MAX_FORGE_PAGES = 40;

export type ForgePullRequestEngineOptions = {
  githubAuth: ContractClient<GitHubAuthContract>;
  /** Yalnızca testler: gerçek ağ yerine sahte fetch. */
  fetch?: FetchLike;
};

type ForgeApi = {
  listPage(
    state: ForgePullRequestStateFilter,
    page: number
  ): Promise<Result<ForgePullRequestPage, HttpClientError>>;
  get(number: number): Promise<Result<ForgePullRequest, HttpClientError>>;
  checks(number: number): Promise<Result<ForgeCheck[], HttpClientError>>;
  comments(number: number): Promise<Result<ForgeComment[], HttpClientError>>;
  create(input: ForgeCreatePullRequestInput): Promise<Result<ForgePullRequest, HttpClientError>>;
  merge(input: ForgeMergeInput): Promise<Result<ForgePullRequest, HttpClientError>>;
};

type ForgeContext = {
  provider: ForgeProvider;
  host: string;
  repositoryUrl: string;
  identity: string;
  api: ForgeApi;
};

/**
 * Bitbucket Cloud ve Azure DevOps Services için PR taşıyıcısı. GitHub motoruyla aynı gözlem
 * sözleşmesini (`GitHubPullRequestRepository`) uygular; önbellek, tazelik ve kimlik çitleri
 * `PullRequestService`te kalır. Kimlik bilgisi her işlemde masaüstünden yeniden istenir.
 */
export class ForgePullRequestEngine implements PullRequestProviderEngine {
  constructor(private readonly options: ForgePullRequestEngineOptions) {}

  async openRepository(
    repositoryUrl: string,
    signal: AbortSignal
  ): Promise<Result<GitHubPullRequestRepository, PullRequestError>> {
    const context = await this.connect(repositoryUrl, signal);
    if (!context.success) return context;
    const forge = context.data;
    return ok({
      identity: forge.identity,
      repositoryUrl: forge.repositoryUrl,
      fetchOpenPage: (cursor, requestSignal) =>
        this.fetchPage(forge, 'open', cursor, requestSignal, 'sync_failed'),
      fetchHistoryPage: (cursor, requestSignal) =>
        this.fetchPage(forge, 'all', cursor, requestSignal, 'sync_failed'),
      fetchPullRequest: async (number, requestSignal) => {
        const fetchedAt = Date.now();
        const result = await forge.api.get(number);
        requestSignal.throwIfAborted();
        if (!result.success) return err(mapForgeError(forge, result.error, 'refresh_failed'));
        return ok({ fetchedAt, data: toMetadata(forge, result.data) });
      },
      fetchChecks: (number, requestSignal) => this.fetchChecks(forge, number, requestSignal),
      fetchComments: async (number, requestSignal) => {
        const fetchedAt = Date.now();
        const result = await forge.api.comments(number);
        requestSignal.throwIfAborted();
        if (!result.success) return err(mapForgeError(forge, result.error, 'comments_failed'));
        const pullRequestUrl = pullRequestUrlFor(forge.repositoryUrl, number);
        return ok({
          fetchedAt,
          data: result.data.map((comment) => toComment(forge, pullRequestUrl, comment)),
        });
      },
    });
  }

  async createPullRequest(
    input: {
      repositoryUrl: string;
      headRepositoryUrl?: string;
      head: string;
      base: string;
      title: string;
      body?: string;
      draft: boolean;
    },
    signal: AbortSignal
  ): Promise<Result<{ url: string; number: number }, PullRequestError>> {
    const context = await this.connect(input.repositoryUrl, signal);
    if (!context.success) return context;
    const forge = context.data;
    const head = input.headRepositoryUrl
      ? parseForgeRepositoryRef(input.headRepositoryUrl)
      : undefined;
    if (head === null || (head && head.repositoryUrl !== forge.repositoryUrl)) {
      return err({
        type: 'create_failed',
        message: `${providerName(forge)} pull requests can only be created from a branch of the same repository. Push the branch to ${forge.repositoryUrl} and try again.`,
      });
    }
    const result = await forge.api.create({
      title: input.title,
      description: input.body ?? '',
      sourceBranch: input.head,
      targetBranch: input.base,
      isDraft: input.draft,
    });
    signal.throwIfAborted();
    if (!result.success) return err(mapForgeError(forge, result.error, 'create_failed'));
    return ok({
      url: pullRequestUrlFor(forge.repositoryUrl, result.data.number),
      number: result.data.number,
    });
  }

  async mergePullRequest(
    repositoryUrl: string,
    number: number,
    options: PullRequestMergeOptions,
    signal: AbortSignal
  ): Promise<Result<{ sha: string | null; merged: boolean }, PullRequestError>> {
    const context = await this.connect(repositoryUrl, signal);
    if (!context.success) return context;
    const forge = context.data;
    if (options.bypassRequirements) {
      return err({
        type: 'merge_failed',
        message: `${providerName(forge)} does not support bypassing merge requirements from Orkestra.`,
      });
    }
    const result = await forge.api.merge({
      number,
      method: options.strategy,
      expectedHeadSha: options.commitHeadOid || undefined,
    });
    signal.throwIfAborted();
    if (!result.success) return err(mapForgeError(forge, result.error, 'merge_failed'));
    return ok({ sha: null, merged: result.data.state === 'merged' });
  }

  async markReadyForReview(
    repositoryUrl: string,
    _number: number,
    _signal: AbortSignal
  ): Promise<Result<void, PullRequestError>> {
    return err({
      type: 'mark_ready_failed',
      message: `${forgeName(repositoryUrl)} drafts cannot be marked ready from Orkestra yet.`,
    });
  }

  async setPullRequestAutoMerge(
    repositoryUrl: string,
    _number: number,
    _options: { enabled: boolean; strategy: PullRequestMergeOptions['strategy'] },
    _signal: AbortSignal
  ): Promise<Result<{ enabled: boolean }, PullRequestError>> {
    return err({
      type: 'merge_failed',
      message: `${forgeName(repositoryUrl)} auto-merge cannot be enabled from Orkestra.`,
    });
  }

  async getPullRequestFiles(
    repositoryUrl: string,
    _number: number,
    _signal: AbortSignal
  ): Promise<Result<PullRequestFile[], PullRequestError>> {
    return err({
      type: 'files_failed',
      message: `${forgeName(repositoryUrl)} pull request files come from the local diff, not the API.`,
    });
  }

  private async fetchPage(
    forge: ForgeContext,
    state: ForgePullRequestStateFilter,
    cursor: string | null,
    signal: AbortSignal,
    operation: PullRequestOperationErrorType
  ): Promise<Result<Observed<PullRequestPage>, PullRequestError>> {
    // İmleç, hizmetin sakladığı sağlayıcıdan bağımsız sayfa numarasıdır ("2", "3", ...).
    const page = cursor === null ? 1 : parsePageCursor(cursor);
    if (page === null) {
      return err({ type: operation, message: `Invalid ${providerName(forge)} page cursor.` });
    }
    if (page > MAX_FORGE_PAGES) {
      return err({
        type: operation,
        message: `${providerName(forge)} lists more than ${MAX_FORGE_PAGES} pages of pull requests; only the first pages were read.`,
      });
    }
    const fetchedAt = Date.now();
    const result = await forge.api.listPage(state, page);
    signal.throwIfAborted();
    if (!result.success) return err(mapForgeError(forge, result.error, operation));
    const nextPage = result.data.nextPage;
    return ok({
      fetchedAt,
      data: {
        prs: result.data.pullRequests.map((pr) => toMetadata(forge, pr)),
        pageInfo:
          nextPage === null
            ? { hasNextPage: false, endCursor: null }
            : { hasNextPage: true, endCursor: String(nextPage) },
      },
    });
  }

  private async fetchChecks(
    forge: ForgeContext,
    number: number,
    signal: AbortSignal
  ): Promise<
    Result<Observed<{ headRefOid: string; checks: PullRequestCheck[] }>, PullRequestError>
  > {
    const fetchedAt = Date.now();
    // Kontroller baş commit'e bağlanır; baş, kontrollerle aynı okuma turunda alınır.
    const pr = await forge.api.get(number);
    signal.throwIfAborted();
    if (!pr.success) return err(mapForgeError(forge, pr.error, 'checks_failed'));
    const headRefOid = pr.data.headSha;
    if (!headRefOid) {
      return err({
        type: 'checks_failed',
        message: `${providerName(forge)} did not report the pull request head commit.`,
      });
    }
    const checks = await forge.api.checks(number);
    signal.throwIfAborted();
    if (!checks.success) return err(mapForgeError(forge, checks.error, 'checks_failed'));
    const pullRequestUrl = pullRequestUrlFor(forge.repositoryUrl, number);
    return ok({
      fetchedAt,
      data: {
        headRefOid,
        checks: checks.data.map((check, index) =>
          toCheck(check, pullRequestUrl, headRefOid, index)
        ),
      },
    });
  }

  private async connect(
    repositoryUrl: string,
    signal: AbortSignal
  ): Promise<Result<ForgeContext, PullRequestError>> {
    const ref = parseForgeRepositoryRef(repositoryUrl);
    if (!ref) return err({ type: 'invalid_repository', input: repositoryUrl });
    const name = pullRequestProviderInfo(ref.provider).name;
    const authRequired = (message: string): PullRequestError => ({
      type: 'forge_auth_required',
      provider: ref.provider,
      host: ref.host,
      message,
    });
    let auth: Awaited<ReturnType<ContractClient<GitHubAuthContract>['resolveAuth']>>;
    try {
      auth = await this.options.githubAuth.resolveAuth(
        { repositoryUrl: ref.repositoryUrl },
        { signal }
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
      return err({ type: 'refresh_failed', message: String(error) });
    }
    signal.throwIfAborted();
    if (!auth.success) return err(mapForgeAuthError(ref.provider, ref.host, auth.error));
    const forge = auth.data.forge;
    if (!forge || forge.provider !== ref.provider) {
      return err(authRequired(`No ${name} credentials were returned for ${ref.repositoryUrl}.`));
    }
    const identity = `${ref.host}\u0000${auth.data.accountId ?? ''}`;
    const base = { provider: ref.provider, host: ref.host, repositoryUrl: ref.repositoryUrl };

    if (forge.provider === 'bitbucket') {
      const credentials = readBitbucketCredentials(forge.credentials);
      if (!credentials.success) return err(authRequired(credentials.error.message));
      const client = createBitbucketClient(credentials.data, { fetch: this.options.fetch });
      if (!client.success) return err(authRequired(client.error.message));
      const repository = resolveBitbucketCloudRepository(ref.repositoryUrl);
      if (!repository.success) return err(authRequired(repository.error.message));
      return ok({
        ...base,
        identity,
        api: bitbucketApi(client.data, repository.data),
      });
    }

    const credentials = readAzureDevOpsCredentials(forge.credentials);
    if (!credentials.success) return err(authRequired(credentials.error.message));
    const client = createAzureDevOpsClient(credentials.data, { fetch: this.options.fetch });
    if (!client.success) return err(authRequired(client.error.message));
    // Kimlik bilgisi yalnızca kendi kuruluşunun depolarına gönderilir.
    const repository = resolveAzureDevOpsRepository(
      ref.repositoryUrl,
      credentials.data.organizationUrl
    );
    if (!repository.success) return err(authRequired(repository.error.message));
    return ok({ ...base, identity, api: azureApi(client.data, repository.data) });
  }
}

function bitbucketApi(client: HttpClient, repository: BitbucketCloudRepository): ForgeApi {
  return {
    listPage: (state, page) => listBitbucketPullRequestPage(client, repository, { state, page }),
    get: (number) => getBitbucketPullRequest(client, repository, number),
    checks: (number) => listBitbucketPullRequestChecks(client, repository, number),
    comments: (number) => listBitbucketPullRequestComments(client, repository, number),
    create: (input) => createBitbucketPullRequest(client, repository, input),
    merge: (input) => mergeBitbucketPullRequest(client, repository, input),
  };
}

function azureApi(client: HttpClient, repository: AzureDevOpsRepository): ForgeApi {
  return {
    listPage: (state, page) => listAzureDevOpsPullRequestPage(client, repository, { state, page }),
    get: (number) => getAzureDevOpsPullRequest(client, repository, number),
    checks: (number) => listAzureDevOpsPullRequestChecks(client, repository, number),
    comments: (number) => listAzureDevOpsPullRequestComments(client, repository, number),
    create: (input) => createAzureDevOpsPullRequest(client, repository, input),
    merge: (input) => mergeAzureDevOpsPullRequest(client, repository, input),
  };
}

function parsePageCursor(cursor: string): number | null {
  if (!/^[1-9][0-9]*$/.test(cursor)) return null;
  const page = Number(cursor);
  return Number.isSafeInteger(page) ? page : null;
}

function providerName(forge: Pick<ForgeContext, 'provider'>): string {
  return pullRequestProviderInfo(forge.provider).name;
}

function forgeName(repositoryUrl: string): string {
  return pullRequestProviderInfo(parseForgeRepositoryRef(repositoryUrl)?.provider).name;
}

/** Sağlayıcının ortak hata sözlüğünü PR hata sözleşmesine çevirir; mesajlar kimlik bilgisi içermez. */
export function mapForgeError(
  forge: Pick<ForgeContext, 'provider' | 'host'>,
  error: HttpClientError | IntegrationError,
  operation: PullRequestOperationErrorType
): PullRequestError {
  switch (error.type) {
    case 'auth_failed':
      return {
        type: 'forge_auth_required',
        provider: forge.provider,
        host: forge.host,
        message: error.message,
      };
    case 'host_unreachable':
      return { type: 'host_unreachable', host: forge.host, reason: error.message };
    default:
      return { type: operation, message: error.message };
  }
}

/** Masaüstünün kimlik çözümü başarısızlıkları; hepsi "hesap gerekli" olarak görünür. */
export function mapForgeAuthError(
  provider: ForgeProvider,
  host: string,
  error: GitHubAuthError
): PullRequestError {
  return { type: 'forge_auth_required', provider, host, message: error.message };
}

export function forgeUser(host: string, actor: ForgeActor): PullRequestUser {
  return {
    userId: `${host}:login:${actor.login}`,
    userName: actor.login,
    displayName: actor.name ?? actor.login,
    avatarUrl: actor.avatarUrl,
    url: null,
    userCreatedAt: null,
    userUpdatedAt: null,
  };
}

/**
 * Sağlayıcı PR'ını önbellek şekline çevirir. `url` her zaman kanonik depo adresinden kurulur
 * (`pullRequestUrlFor`), böylece önbellek anahtarı sağlayıcının döndürdüğü ana makine/büyük-küçük
 * harf farklarından etkilenmez. Çatal (fork) PR'lar aynı depo dalı olarak görünür.
 */
export function toMetadata(
  forge: Pick<ForgeContext, 'provider' | 'host' | 'repositoryUrl'>,
  pr: ForgePullRequest
): PullRequestMetadata {
  return {
    url: pullRequestUrlFor(forge.repositoryUrl, pr.number),
    provider: forge.provider,
    repositoryUrl: forge.repositoryUrl,
    baseRefName: pr.baseBranch,
    baseRefOid: pr.baseSha ?? '',
    headRepositoryUrl: forge.repositoryUrl,
    headRefName: pr.headBranch,
    headRefOid: pr.headSha ?? '',
    identifier: `#${pr.number}`,
    title: pr.title,
    description: pr.body || null,
    status: pr.state,
    isDraft: pr.isDraft,
    additions: null,
    deletions: null,
    changedFiles: null,
    commitCount: null,
    mergeableStatus:
      pr.mergeability === 'mergeable'
        ? 'MERGEABLE'
        : pr.mergeability === 'conflicting'
          ? 'CONFLICTING'
          : 'UNKNOWN',
    mergeStateStatus: null,
    reviewDecision: null,
    checkSummary: null,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    author: pr.author ? forgeUser(forge.host, pr.author) : null,
    labels: [],
    assignees: [],
  };
}

const checkConclusions: Record<ForgeCheck['status'], string | null> = {
  success: 'SUCCESS',
  failure: 'FAILURE',
  cancelled: 'CANCELLED',
  skipped: 'SKIPPED',
  neutral: 'NEUTRAL',
  'action-required': 'ACTION_REQUIRED',
  pending: null,
};

export function toCheck(
  check: ForgeCheck,
  pullRequestUrl: string,
  headRefOid: string,
  index: number
): PullRequestCheck {
  return {
    id: `${headRefOid}:${index}:${check.name}`,
    pullRequestUrl,
    commitSha: headRefOid,
    name: check.name,
    status: check.status === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
    conclusion: checkConclusions[check.status],
    detailsUrl: check.url,
    startedAt: null,
    completedAt: null,
    workflowName: check.description,
    appName: null,
    appLogoUrl: null,
  };
}

function toComment(
  forge: Pick<ForgeContext, 'provider' | 'host'>,
  pullRequestUrl: string,
  comment: ForgeComment
): PullRequestComment {
  return {
    id: `${forge.provider}-comment:${comment.id}`,
    pullRequestUrl,
    kind: comment.path ? 'review' : 'issue',
    body: comment.body,
    url: comment.url ?? pullRequestUrl,
    author: comment.author ? forgeUser(forge.host, comment.author) : null,
    path: comment.path,
    line: null,
    isResolved: false,
    isOutdated: false,
    createdAt: comment.createdAt,
    updatedAt: comment.createdAt,
  };
}
