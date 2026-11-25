import {
  azureDevOpsCredentialsSchema,
  bitbucketCredentialsSchema,
} from '@orkestra/plugins/integrations/forge';
import { err, ok, type Result } from '@orkestra/shared';
import type { ForgeProvider } from '@core/primitives/repository/api';
import type { ForgeAuth, GitHubAuthError } from '../api';

export type ReadForgeCredentials = (
  provider: ForgeProvider,
  accountId: string,
  host: string
) => Promise<Result<ForgeAuth, GitHubAuthError>>;

/**
 * Seçilmiş tek bir Bitbucket / Azure DevOps hesabının kimlik bilgisini okur; hesap seçimi
 * çağıranındır (GitHub'daki `createGitHubCredentialReader` ile aynı kural). Eksik ya da okunamayan
 * kayıt kapalı başarısız olur; başka hesaba geçilmez.
 */
export function createForgeCredentialReader(
  credentials: {
    getAccount(providerId: string, accountId?: string): Promise<{ credentials: unknown } | null>;
  },
  accountLookup: { getAccount(providerId: string, accountId?: string): Promise<unknown> }
): ReadForgeCredentials {
  return async (provider, accountId, host) => {
    const selectedId = accountId.trim();
    if (!selectedId) {
      return err({
        type: 'account_not_found',
        host,
        accountId: selectedId,
        message: 'No account was selected for this repository.',
      });
    }
    const stored = await credentials.getAccount(provider, selectedId);
    if (!stored) {
      const exists = await accountLookup.getAccount(provider, selectedId);
      return err(
        exists
          ? {
              type: 'token_missing',
              host,
              accountId: selectedId,
              message: 'The saved credentials for this account could not be read. Reconnect it.',
            }
          : {
              type: 'account_not_found',
              host,
              accountId: selectedId,
              message: 'The selected account is no longer connected.',
            }
      );
    }
    const invalid = (): Result<ForgeAuth, GitHubAuthError> =>
      err({
        type: 'token_missing',
        host,
        accountId: selectedId,
        message: 'The saved credentials for this account are incomplete. Reconnect it.',
      });
    if (provider === 'bitbucket') {
      const parsed = bitbucketCredentialsSchema.safeParse(stored.credentials);
      if (!parsed.success) return invalid();
      return ok({
        provider,
        credentials: {
          ...(parsed.data.email ? { email: parsed.data.email } : {}),
          apiToken: parsed.data.apiToken,
        },
      });
    }
    const parsed = azureDevOpsCredentialsSchema.safeParse(stored.credentials);
    if (!parsed.success) return invalid();
    return ok({ provider, credentials: parsed.data });
  };
}
