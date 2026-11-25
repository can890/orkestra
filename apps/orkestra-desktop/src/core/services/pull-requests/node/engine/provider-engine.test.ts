import { ok } from '@orkestra/shared';
import { describe, expect, it, vi } from 'vitest';
import { RoutingPullRequestEngine, type PullRequestProviderEngine } from './provider-engine';

function stubEngine(
  name: string
): PullRequestProviderEngine & Record<string, ReturnType<typeof vi.fn>> {
  return {
    openRepository: vi.fn(async () => ok({ name } as never)),
    createPullRequest: vi.fn(async () => ok({ url: name, number: 1 })),
    mergePullRequest: vi.fn(async () => ok({ sha: name, merged: true })),
    markReadyForReview: vi.fn(async () => ok(undefined)),
    setPullRequestAutoMerge: vi.fn(async () => ok({ enabled: true })),
    getPullRequestFiles: vi.fn(async () => ok([])),
  };
}

describe('RoutingPullRequestEngine', () => {
  const signal = new AbortController().signal;

  it.each(['https://github.com/acme/repo', 'https://ghe.example.com/acme/repo'])(
    'keeps %s on the GitHub engine for every operation',
    async (repositoryUrl) => {
      const github = stubEngine('github');
      const forge = stubEngine('forge');
      const engine = new RoutingPullRequestEngine(github, forge);
      await engine.openRepository(repositoryUrl, signal);
      await engine.createPullRequest(
        { repositoryUrl, head: 'b', base: 'main', title: 't', draft: false },
        signal
      );
      await engine.mergePullRequest(repositoryUrl, 1, { strategy: 'merge' }, signal);
      await engine.markReadyForReview(repositoryUrl, 1, signal);
      await engine.setPullRequestAutoMerge(
        repositoryUrl,
        1,
        { enabled: true, strategy: 'merge' },
        signal
      );
      await engine.getPullRequestFiles(repositoryUrl, 1, signal);
      for (const method of Object.values(github)) expect(method).toHaveBeenCalledTimes(1);
      for (const method of Object.values(forge)) expect(method).not.toHaveBeenCalled();
    }
  );

  it.each(['https://bitbucket.org/acme/web', 'https://dev.azure.com/acme/Web/_git/api'])(
    'sends %s to the forge engine',
    async (repositoryUrl) => {
      const github = stubEngine('github');
      const forge = stubEngine('forge');
      const engine = new RoutingPullRequestEngine(github, forge);
      await engine.openRepository(repositoryUrl, signal);
      await engine.mergePullRequest(repositoryUrl, 1, { strategy: 'merge' }, signal);
      expect(forge.openRepository).toHaveBeenCalledWith(repositoryUrl, signal);
      expect(forge.mergePullRequest).toHaveBeenCalled();
      expect(github.openRepository).not.toHaveBeenCalled();
    }
  );
});
