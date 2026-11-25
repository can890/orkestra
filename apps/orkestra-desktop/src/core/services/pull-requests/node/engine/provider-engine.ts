import { err, type Result } from '@orkestra/shared';
import {
  pullRequestProviderForRepositoryUrl,
  type PullRequestError,
  type PullRequestFile,
  type PullRequestFileViews,
  type PullRequestReviewRevision,
  type SetPullRequestFileViewed,
  type PullRequestMergeOptions,
} from '../../api';
import {
  ForgePullRequestEngine,
  type ForgePullRequestEngineOptions,
} from './forge-pull-request-engine';
import type { GitHubPullRequestRepository } from './observation';
import { PullRequestEngine, type PullRequestEngineOptions } from './pull-request-engine';

/**
 * Sağlayıcıdan bağımsız PR taşıyıcı arayüzü: `PullRequestService` yalnızca bunu görür. GitHub
 * motoru (`PullRequestEngine`) ve Bitbucket/Azure DevOps motoru (`ForgePullRequestEngine`) aynı
 * yüzü uygular.
 */
export interface PullRequestProviderEngine {
  openRepository(
    repositoryUrl: string,
    signal: AbortSignal
  ): Promise<Result<GitHubPullRequestRepository, PullRequestError>>;
  createPullRequest(
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
  ): Promise<Result<{ url: string; number: number }, PullRequestError>>;
  mergePullRequest(
    repositoryUrl: string,
    number: number,
    options: PullRequestMergeOptions,
    signal: AbortSignal
  ): Promise<Result<{ sha: string | null; merged: boolean }, PullRequestError>>;
  markReadyForReview(
    repositoryUrl: string,
    number: number,
    signal: AbortSignal
  ): Promise<Result<void, PullRequestError>>;
  setPullRequestAutoMerge(
    repositoryUrl: string,
    number: number,
    options: { enabled: boolean; strategy: PullRequestMergeOptions['strategy'] },
    signal: AbortSignal
  ): Promise<Result<{ enabled: boolean }, PullRequestError>>;
  getPullRequestFileViews?(
    input: PullRequestReviewRevision,
    signal: AbortSignal
  ): Promise<Result<PullRequestFileViews, PullRequestError>>;
  setPullRequestFileViewed?(
    input: SetPullRequestFileViewed,
    signal: AbortSignal
  ): Promise<Result<void, PullRequestError>>;
  getPullRequestFiles(
    repositoryUrl: string,
    number: number,
    signal: AbortSignal
  ): Promise<Result<PullRequestFile[], PullRequestError>>;
}

/**
 * Depo adresinin ana makinesine göre motoru seçer: `bitbucket.org` ve `dev.azure.com` forge
 * motoruna, geri kalan her şey (github.com ve GHES) değişmeden GitHub motoruna gider.
 */
export class RoutingPullRequestEngine implements PullRequestProviderEngine {
  constructor(
    private readonly github: PullRequestProviderEngine,
    private readonly forge: PullRequestProviderEngine
  ) {}

  private select(repositoryUrl: string): PullRequestProviderEngine {
    return pullRequestProviderForRepositoryUrl(repositoryUrl) === 'github'
      ? this.github
      : this.forge;
  }

  openRepository(repositoryUrl: string, signal: AbortSignal) {
    return this.select(repositoryUrl).openRepository(repositoryUrl, signal);
  }

  createPullRequest(
    input: Parameters<PullRequestProviderEngine['createPullRequest']>[0],
    signal: AbortSignal
  ) {
    return this.select(input.repositoryUrl).createPullRequest(input, signal);
  }

  mergePullRequest(
    repositoryUrl: string,
    number: number,
    options: PullRequestMergeOptions,
    signal: AbortSignal
  ) {
    return this.select(repositoryUrl).mergePullRequest(repositoryUrl, number, options, signal);
  }

  markReadyForReview(repositoryUrl: string, number: number, signal: AbortSignal) {
    return this.select(repositoryUrl).markReadyForReview(repositoryUrl, number, signal);
  }

  setPullRequestAutoMerge(
    repositoryUrl: string,
    number: number,
    options: { enabled: boolean; strategy: PullRequestMergeOptions['strategy'] },
    signal: AbortSignal
  ) {
    return this.select(repositoryUrl).setPullRequestAutoMerge(
      repositoryUrl,
      number,
      options,
      signal
    );
  }

  getPullRequestFileViews(input: PullRequestReviewRevision, signal: AbortSignal) {
    return (
      this.select(input.repositoryUrl).getPullRequestFileViews?.(input, signal) ??
      Promise.resolve(
        err<PullRequestError>({
          type: 'files_failed',
          message: 'File viewing is unavailable for this provider',
        })
      )
    );
  }

  setPullRequestFileViewed(input: SetPullRequestFileViewed, signal: AbortSignal) {
    return (
      this.select(input.repositoryUrl).setPullRequestFileViewed?.(input, signal) ??
      Promise.resolve(
        err<PullRequestError>({
          type: 'files_failed',
          message: 'File viewing is unavailable for this provider',
        })
      )
    );
  }

  getPullRequestFiles(repositoryUrl: string, number: number, signal: AbortSignal) {
    return this.select(repositoryUrl).getPullRequestFiles(repositoryUrl, number, signal);
  }
}

export function createPullRequestEngine(
  options: PullRequestEngineOptions & Pick<ForgePullRequestEngineOptions, 'fetch'>
): PullRequestProviderEngine {
  const { fetch, ...githubOptions } = options;
  return new RoutingPullRequestEngine(
    new PullRequestEngine(githubOptions),
    new ForgePullRequestEngine({ githubAuth: options.githubAuth, fetch })
  );
}
