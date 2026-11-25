import { err, ok } from '@orkestra/shared';
import { describe, expect, it, vi } from 'vitest';
import { createPullRequestsGitHubAuthController } from '@core/services/pull-requests/node/pull-requests-auth';

describe('pull requests GitHub auth controller', () => {
  it('uses the selected account’s stored Enterprise endpoint', async () => {
    const controller = createPullRequestsGitHubAuthController(
      async () =>
        ok({
          accessToken: 'enterprise-token',
          apiBaseUrl: 'https://ghe.example.com/github/api/v3',
        }),
      async () => ok({ accountId: 'ghe.example.com:42' })
    );
    await expect(
      controller.call('resolveAuth', { repositoryUrl: 'https://ghe.example.com/acme/repo' })
    ).resolves.toEqual(
      ok({
        token: 'enterprise-token',
        host: 'ghe.example.com',
        apiBaseUrl: 'https://ghe.example.com/github/api/v3',
        accountId: 'ghe.example.com:42',
      })
    );
  });

  it('resolves identity per request, then the matching token', async () => {
    const readCredentials = vi.fn(async () =>
      ok({ accessToken: 'secret-token', apiBaseUrl: 'https://api.github.com' })
    );
    const resolveSyncIdentity = vi.fn(async () => ok({ accountId: 'account-1' }));
    const controller = createPullRequestsGitHubAuthController(readCredentials, resolveSyncIdentity);

    await expect(
      controller.call('resolveAuth', {
        repositoryUrl: 'https://GitHub.COM/orkestra/orkestra',
      })
    ).resolves.toEqual(
      ok({
        token: 'secret-token',
        host: 'github.com',
        apiBaseUrl: 'https://api.github.com',
        accountId: 'account-1',
      })
    );
    expect(resolveSyncIdentity).toHaveBeenCalledWith('https://GitHub.COM/orkestra/orkestra');
    expect(readCredentials).toHaveBeenCalledWith('account-1', 'github.com');
  });

  it('fails closed when identity resolution fails, without fetching a token', async () => {
    const error = {
      type: 'account_unresolvable' as const,
      host: 'github.com',
      message: 'The pinned GitHub account no longer exists.',
    };
    const readCredentials = vi.fn(async () =>
      ok({ accessToken: 'secret-token', apiBaseUrl: 'https://api.github.com' })
    );
    const controller = createPullRequestsGitHubAuthController(
      readCredentials,
      vi.fn(async () => err(error))
    );

    await expect(
      controller.call('resolveAuth', {
        repositoryUrl: 'https://github.com/orkestra/orkestra',
      })
    ).resolves.toEqual(err(error));
    expect(readCredentials).not.toHaveBeenCalled();
  });

  it('preserves typed authentication failures', async () => {
    const error = {
      type: 'account_not_found' as const,
      host: 'github.example.com',
      accountId: 'missing',
      message: 'Account not found',
      hint: 'Reconnect the account',
    };
    const controller = createPullRequestsGitHubAuthController(
      vi.fn(async () => err(error)),
      vi.fn(async () => ok({ accountId: 'missing' }))
    );

    await expect(
      controller.call('resolveAuth', {
        repositoryUrl: 'https://github.example.com/orkestra/orkestra',
      })
    ).resolves.toEqual(err(error));
  });
  it('returns Bitbucket credentials for a canonical Bitbucket repository, never the GitHub token', async () => {
    const readCredentials = vi.fn(async () =>
      ok({ accessToken: 'github-token', apiBaseUrl: 'https://api.github.com' })
    );
    const resolveSyncIdentity = vi.fn(async () => ok({ accountId: 'bb-1' }));
    const readForgeCredentials = vi.fn(async () =>
      ok({ provider: 'bitbucket' as const, credentials: { apiToken: 'bb-token' } })
    );
    const controller = createPullRequestsGitHubAuthController(
      readCredentials,
      resolveSyncIdentity,
      readForgeCredentials
    );
    await expect(
      controller.call('resolveAuth', { repositoryUrl: 'git@bitbucket.org:acme/web.git' })
    ).resolves.toEqual(
      ok({
        token: '',
        host: 'bitbucket.org',
        apiBaseUrl: '',
        accountId: 'bb-1',
        forge: { provider: 'bitbucket', credentials: { apiToken: 'bb-token' } },
      })
    );
    expect(resolveSyncIdentity).toHaveBeenCalledWith('https://bitbucket.org/acme/web');
    expect(readForgeCredentials).toHaveBeenCalledWith('bitbucket', 'bb-1', 'bitbucket.org');
    expect(readCredentials).not.toHaveBeenCalled();
  });

  it('fails closed for Azure DevOps when identity resolution fails', async () => {
    const readForgeCredentials = vi.fn();
    const failure = {
      type: 'auth_required' as const,
      host: 'dev.azure.com',
      message: 'No Azure DevOps account is configured for this project.',
    };
    const controller = createPullRequestsGitHubAuthController(
      vi.fn(),
      vi.fn(async () => err(failure)),
      readForgeCredentials
    );
    await expect(
      controller.call('resolveAuth', {
        repositoryUrl: 'https://dev.azure.com/acme/Web/_git/api',
      })
    ).resolves.toEqual(err(failure));
    expect(readForgeCredentials).not.toHaveBeenCalled();
  });
});
