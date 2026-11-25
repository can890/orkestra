import { err, ok, type Result } from '@orkestra/shared';
import { createController, type Controller } from '@orkestra/wire/rpc';
import { parseForgeRepositoryRef, parseRepositoryRef } from '@core/primitives/repository/api';
import { githubAuthContract, type GitHubAuthError } from '@core/services/pull-requests/api';
import type { ReadForgeCredentials } from './forge-credentials';
import type { PullRequestSyncIdentityResolver } from './sync-identity';

type ReadGitHubCredentials = (
  accountId: string,
  expectedHost: string
) => Promise<Result<{ accessToken: string; apiBaseUrl: string }, GitHubAuthError>>;

/**
 * Desktop-side answer to the worker's per-sync identity request (spec:
 * github-git-settings §8): resolve *as whom* through the blessed resolver for
 * the repository, then fetch that account's token. Identity failures pass
 * through fail-closed — the worker skips the sync instead of running as a
 * different account.
 */
export function createPullRequestsGitHubAuthController(
  readCredentials: ReadGitHubCredentials,
  resolveSyncIdentity: PullRequestSyncIdentityResolver,
  readForgeCredentials?: ReadForgeCredentials
): Controller {
  return createController(githubAuthContract, {
    resolveAuth: async (input) => {
      // Bitbucket Cloud / Azure DevOps: same fail-closed identity resolution, provider credentials
      // returned in `forge`. Every other host stays on the GitHub path below, unchanged.
      const forge = parseForgeRepositoryRef(input.repositoryUrl);
      if (forge) {
        if (!readForgeCredentials) {
          return err({
            type: 'account_unresolvable',
            host: forge.host,
            message: 'Pull requests for this provider are not available in this process.',
          });
        }
        const identity = await resolveSyncIdentity(forge.repositoryUrl);
        if (!identity.success) return identity;
        const credentials = await readForgeCredentials(
          forge.provider,
          identity.data.accountId,
          forge.host
        );
        if (!credentials.success) return credentials;
        return ok({
          token: '',
          host: forge.host,
          apiBaseUrl: '',
          accountId: identity.data.accountId,
          forge: credentials.data,
        });
      }
      const repository = parseRepositoryRef(input.repositoryUrl);
      if (!repository) {
        return err({
          type: 'account_unresolvable',
          host: 'unknown',
          message: `Unrecognized repository URL: ${input.repositoryUrl}`,
        });
      }
      const identity = await resolveSyncIdentity(input.repositoryUrl);
      if (!identity.success) return identity;
      const credentials = await readCredentials(identity.data.accountId, repository.host);
      if (!credentials.success) return credentials;
      return ok({
        token: credentials.data.accessToken,
        host: repository.host,
        apiBaseUrl: credentials.data.apiBaseUrl,
        accountId: identity.data.accountId,
      });
    },
  });
}
