import { describe, expect, it, vi } from 'vitest';
import { selectForgeAccountForRepository } from './forge-account';

const accounts = [{ accountId: 'contoso' }, { accountId: 'acme' }, { accountId: 'other' }];
const organizations: Record<string, string> = {
  contoso: 'https://dev.azure.com/contoso',
  acme: 'https://dev.azure.com/Acme',
  other: 'https://dev.azure.com/other',
};
const read = vi.fn(async (accountId: string) => organizations[accountId] ?? null);

describe('selectForgeAccountForRepository', () => {
  it('picks the Azure DevOps account of the repository organization over an inferred default', async () => {
    await expect(
      selectForgeAccountForRepository(
        'https://dev.azure.com/acme/Web/_git/api',
        {
          value: accounts[0],
          provenance: { kind: 'inferred', from: 'default account' },
          accounts,
        },
        read
      )
    ).resolves.toEqual({ accountId: 'acme' });
  });

  it('finds the organization account when host matching inferred none', async () => {
    await expect(
      selectForgeAccountForRepository(
        'git@ssh.dev.azure.com:v3/acme/Web/api',
        {
          value: null,
          provenance: { kind: 'inferred', from: 'no host-matching account' },
          accounts,
        },
        read
      )
    ).resolves.toEqual({ accountId: 'acme' });
  });

  it('never overrides an explicitly pinned account', async () => {
    const pinned = { value: accounts[0], provenance: { kind: 'set' as const }, accounts };
    await expect(
      selectForgeAccountForRepository('https://dev.azure.com/acme/Web/_git/api', pinned, read)
    ).resolves.toEqual({ accountId: 'contoso' });
  });

  it('leaves Bitbucket resolution unchanged without reading credentials', async () => {
    const reader = vi.fn();
    const resolution = {
      value: accounts[0],
      provenance: { kind: 'inferred' as const, from: 'default account' as const },
      accounts,
    };
    await expect(
      selectForgeAccountForRepository('https://bitbucket.org/acme/web', resolution, reader)
    ).resolves.toBe(accounts[0]);
    expect(reader).not.toHaveBeenCalled();
  });
});
