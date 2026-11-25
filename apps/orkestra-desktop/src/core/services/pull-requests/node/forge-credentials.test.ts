import { describe, expect, it, vi } from 'vitest';
import { createForgeCredentialReader } from './forge-credentials';

describe('createForgeCredentialReader', () => {
  it('reads the selected Bitbucket account only', async () => {
    const getAccount = vi.fn(async () => ({
      credentials: { email: 'ada@example.com', apiToken: 'bb-token' },
    }));
    const read = createForgeCredentialReader({ getAccount }, { getAccount: vi.fn() });
    await expect(read('bitbucket', 'bb-1', 'bitbucket.org')).resolves.toEqual({
      success: true,
      data: {
        provider: 'bitbucket',
        credentials: { email: 'ada@example.com', apiToken: 'bb-token' },
      },
    });
    expect(getAccount).toHaveBeenCalledWith('bitbucket', 'bb-1');
  });

  it('normalizes the Azure DevOps organization URL', async () => {
    const read = createForgeCredentialReader(
      {
        getAccount: async () => ({
          credentials: { organizationUrl: 'acme', personalAccessToken: 'pat' },
        }),
      },
      { getAccount: vi.fn() }
    );
    await expect(read('azure-devops', 'ado-1', 'dev.azure.com')).resolves.toMatchObject({
      success: true,
      data: {
        provider: 'azure-devops',
        credentials: { organizationUrl: 'https://dev.azure.com/acme', personalAccessToken: 'pat' },
      },
    });
  });

  it('distinguishes a removed account from unreadable credentials', async () => {
    const missing = createForgeCredentialReader(
      { getAccount: async () => null },
      { getAccount: async () => null }
    );
    await expect(missing('bitbucket', 'gone', 'bitbucket.org')).resolves.toMatchObject({
      success: false,
      error: { type: 'account_not_found', accountId: 'gone' },
    });
    const unreadable = createForgeCredentialReader(
      { getAccount: async () => null },
      { getAccount: async () => ({ accountId: 'bb-1' }) }
    );
    await expect(unreadable('bitbucket', 'bb-1', 'bitbucket.org')).resolves.toMatchObject({
      success: false,
      error: { type: 'token_missing' },
    });
    const incomplete = createForgeCredentialReader(
      { getAccount: async () => ({ credentials: { email: 'ada@example.com' } }) },
      { getAccount: vi.fn() }
    );
    await expect(incomplete('bitbucket', 'bb-1', 'bitbucket.org')).resolves.toMatchObject({
      success: false,
      error: { type: 'token_missing' },
    });
  });
});
