import { describe, expect, it } from 'vitest';
import {
  providerAccountHostMatching,
  resolveProviderAccount,
} from '@core/primitives/project-settings/api/resolve-provider-account';
import { normalizeAccountMatchHost, parseRepositoryRef } from './repository-ref';

describe('normalizeAccountMatchHost', () => {
  it.each([
    ['dev.azure.com', 'dev.azure.com'],
    ['ssh.dev.azure.com', 'dev.azure.com'],
    ['acme.visualstudio.com', 'dev.azure.com'],
    ['vs-ssh.visualstudio.com', 'dev.azure.com'],
    ['bitbucket.org', 'bitbucket.org'],
    ['altssh.bitbucket.org', 'bitbucket.org'],
    ['www.github.com', 'github.com'],
    ['gitlab.example.com', 'gitlab.example.com'],
    ['bitbucket.example.com', 'bitbucket.example.com'],
    ['dev.azure.com.evil.test', 'dev.azure.com.evil.test'],
  ])('%s → %s', (host, expected) => {
    expect(normalizeAccountMatchHost(host)).toBe(expected);
  });

  it('keeps the real host in parsed repository URLs', () => {
    expect(parseRepositoryRef('git@ssh.dev.azure.com:v3/acme/Web/api')?.repositoryUrl).toBe(
      'https://ssh.dev.azure.com/v3/acme/Web/api'
    );
  });

  it('infers the Azure DevOps account for every Azure clone host', () => {
    const accounts = [{ accountId: 'ado', isDefault: false, host: 'dev.azure.com' }];
    for (const remote of [
      'git@ssh.dev.azure.com:v3/acme/Web/api',
      'https://acme.visualstudio.com/Web/_git/api',
      'https://acme@dev.azure.com/acme/Web/_git/api',
    ]) {
      const host = parseRepositoryRef(remote)?.host ?? null;
      expect(
        resolveProviderAccount(undefined, accounts, providerAccountHostMatching(host)).value
      ).toEqual(accounts[0]);
    }
  });
});
