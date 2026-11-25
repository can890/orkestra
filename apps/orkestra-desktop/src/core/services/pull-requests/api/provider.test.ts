import { describe, expect, it } from 'vitest';
import {
  pullRequestProviderForRepositoryUrl,
  pullRequestProviderInfo,
  pullRequestUrlFor,
} from './provider';
import { normalizeRepositoryUrl } from './repository';

describe('pull request provider resolution', () => {
  it.each([
    ['https://github.com/acme/repo', 'github'],
    ['https://ghe.example.com/acme/repo', 'github'],
    ['https://gitlab.com/acme/repo', 'github'],
    ['git@bitbucket.org:acme/web.git', 'bitbucket'],
    ['ssh://git@altssh.bitbucket.org:443/acme/web.git', 'bitbucket'],
    ['https://dev.azure.com/acme/Web/_git/api', 'azure-devops'],
    ['git@ssh.dev.azure.com:v3/acme/Web/api', 'azure-devops'],
    ['https://acme.visualstudio.com/Web/_git/api', 'azure-devops'],
    ['https://bitbucket.example.com/scm/ACME/web.git', 'github'],
  ] as const)('%s → %s', (url, provider) => {
    expect(pullRequestProviderForRepositoryUrl(url)).toBe(provider);
  });

  it('keeps GitHub PR URLs byte-for-byte', () => {
    expect(pullRequestUrlFor('https://github.com/acme/repo', 12)).toBe(
      'https://github.com/acme/repo/pull/12'
    );
    expect(pullRequestUrlFor('https://ghe.example.com:8443/acme/repo', 3)).toBe(
      'https://ghe.example.com:8443/acme/repo/pull/3'
    );
  });

  it('builds the provider web URL that the PR cache is keyed by', () => {
    expect(pullRequestUrlFor('https://bitbucket.org/acme/web', 7)).toBe(
      'https://bitbucket.org/acme/web/pull-requests/7'
    );
    expect(pullRequestUrlFor('https://dev.azure.com/acme/Web/_git/api', 42)).toBe(
      'https://dev.azure.com/acme/Web/_git/api/pullrequest/42'
    );
  });

  it('normalizes every clone shape of one forge repository to the same cache key', () => {
    const bitbucket = [
      'git@bitbucket.org:acme/web.git',
      'https://ada@bitbucket.org/acme/web.git',
      'ssh://git@altssh.bitbucket.org:443/acme/web.git',
      'https://bitbucket.org/acme/web',
    ].map(normalizeRepositoryUrl);
    expect(new Set(bitbucket)).toEqual(new Set(['https://bitbucket.org/acme/web']));
    const azure = [
      'https://dev.azure.com/acme/Web/_git/api',
      'https://acme@dev.azure.com/acme/Web/_git/api',
      'git@ssh.dev.azure.com:v3/acme/Web/api',
      'ssh://git@ssh.dev.azure.com/v3/acme/Web/api',
      'https://acme.visualstudio.com/Web/_git/api',
      'https://acme.visualstudio.com/DefaultCollection/Web/_git/api',
    ].map(normalizeRepositoryUrl);
    expect(new Set(azure)).toEqual(new Set(['https://dev.azure.com/acme/Web/_git/api']));
  });

  it('declares the capabilities the UI degrades on', () => {
    expect(pullRequestProviderInfo('github')).toMatchObject({
      autoMerge: true,
      markReadyForReview: true,
      bypassRequirements: true,
    });
    for (const provider of ['bitbucket', 'azure-devops']) {
      expect(pullRequestProviderInfo(provider)).toMatchObject({
        autoMerge: false,
        markReadyForReview: false,
        bypassRequirements: false,
        mergeStateStatus: false,
      });
    }
    expect(pullRequestProviderInfo('unknown').id).toBe('github');
  });
});
