import { describe, expect, it } from 'vitest';
import {
  isAzureDevOpsHost,
  normalizeAzureDevOpsOrganizationUrl,
  organizationFromUrl,
  parseAzureDevOpsRemote,
  resolveAzureDevOpsRepository,
} from './remote';

describe('parseAzureDevOpsRemote', () => {
  it.each([
    ['https://dev.azure.com/acme/Web/_git/api', 'acme', 'Web', 'api'],
    ['https://acme@dev.azure.com/acme/Web/_git/api', 'acme', 'Web', 'api'],
    ['https://dev.azure.com/acme/Web/_git/api.git', 'acme', 'Web', 'api'],
    ['https://dev.azure.com/acme/My%20Project/_git/My%20Repo', 'acme', 'My Project', 'My Repo'],
    ['https://dev.azure.com/acme/_git/api', 'acme', 'api', 'api'],
    ['https://dev.azure.com/acme/Web/_git/_optimized/api', 'acme', 'Web', 'api'],
    ['https://dev.azure.com/acme/Web/_git/_full/api', 'acme', 'Web', 'api'],
    ['https://dev.azure.com/acme/Web/_git/api/pullrequest/12', 'acme', 'Web', 'api'],
    ['https://acme.visualstudio.com/Web/_git/api', 'acme', 'Web', 'api'],
    ['https://acme.visualstudio.com/DefaultCollection/Web/_git/api', 'acme', 'Web', 'api'],
    ['https://acme.visualstudio.com/_git/api', 'acme', 'api', 'api'],
    ['git@ssh.dev.azure.com:v3/acme/Web/api', 'acme', 'Web', 'api'],
    ['ssh://git@ssh.dev.azure.com/v3/acme/Web/api', 'acme', 'Web', 'api'],
    ['ssh://git@ssh.dev.azure.com:22/v3/acme/Web/api', 'acme', 'Web', 'api'],
    ['acme@vs-ssh.visualstudio.com:v3/acme/Web/api', 'acme', 'Web', 'api'],
    ['git@ssh.dev.azure.com:v3/acme/My%20Project/api', 'acme', 'My Project', 'api'],
    // Masaüstünün remote normalizasyonundan sonra gelen biçim.
    ['https://ssh.dev.azure.com/v3/acme/Web/api', 'acme', 'Web', 'api'],
  ])('parses %s', (remote, organization, project, repository) => {
    expect(parseAzureDevOpsRemote(remote)).toMatchObject({
      organization,
      project,
      repository,
      organizationUrl: `https://dev.azure.com/${organization}`,
    });
  });

  it('builds the canonical web URL', () => {
    expect(parseAzureDevOpsRemote('git@ssh.dev.azure.com:v3/acme/My%20Project/api')?.webUrl).toBe(
      'https://dev.azure.com/acme/My%20Project/_git/api'
    );
  });

  it.each([
    '',
    'https://github.com/acme/web.git',
    'https://dev.azure.com/acme/Web',
    'https://dev.azure.com/acme/Web/_git',
    'https://dev.azure.com/a/b/c/_git/api',
    'git@ssh.dev.azure.com:v3/acme/Web',
    'https://evil.com/acme.visualstudio.com/Web/_git/api',
    'https://dev.azure.com.evil.test/acme/Web/_git/api',
  ])('rejects %j', (remote) => {
    expect(parseAzureDevOpsRemote(remote)).toBeNull();
  });

  it('identifies Azure hosts', () => {
    expect(isAzureDevOpsHost('dev.azure.com')).toBe(true);
    expect(isAzureDevOpsHost('ssh.dev.azure.com')).toBe(true);
    expect(isAzureDevOpsHost('acme.visualstudio.com')).toBe(true);
    expect(isAzureDevOpsHost('vs-ssh.visualstudio.com')).toBe(true);
    expect(isAzureDevOpsHost('azure.com')).toBe(false);
  });
});

describe('organization URLs', () => {
  it.each([
    ['acme', 'https://dev.azure.com/acme'],
    [' https://dev.azure.com/acme/ ', 'https://dev.azure.com/acme'],
    ['https://dev.azure.com/acme/Web/_git/api', 'https://dev.azure.com/acme'],
    ['dev.azure.com/acme', 'https://dev.azure.com/acme'],
    ['https://acme.visualstudio.com', 'https://dev.azure.com/acme'],
    ['https://acme.visualstudio.com/DefaultCollection', 'https://dev.azure.com/acme'],
  ])('normalizes %j', (input, expected) => {
    expect(normalizeAzureDevOpsOrganizationUrl(input)).toBe(expected);
  });

  it.each(['', 'https://tfs.example.com/tfs/DefaultCollection', 'https://dev.azure.com/', 'a b'])(
    'rejects %j',
    (input) => {
      expect(normalizeAzureDevOpsOrganizationUrl(input)).toBeNull();
    }
  );

  it('extracts the organization', () => {
    expect(organizationFromUrl('https://dev.azure.com/acme')).toBe('acme');
    expect(organizationFromUrl('https://acme.visualstudio.com')).toBe('acme');
    expect(organizationFromUrl('nope')).toBeNull();
  });
});

describe('resolveAzureDevOpsRepository', () => {
  it('accepts a repository in the credential organization (case-insensitive)', () => {
    expect(
      resolveAzureDevOpsRepository(
        'git@ssh.dev.azure.com:v3/ACME/Web/api',
        'https://dev.azure.com/acme'
      )
    ).toMatchObject({ success: true, data: { project: 'Web', repository: 'api' } });
  });

  it('refuses to use credentials for another organization', () => {
    expect(
      resolveAzureDevOpsRepository(
        'https://dev.azure.com/other/Web/_git/api',
        'https://dev.azure.com/acme'
      )
    ).toMatchObject({ success: false, error: { type: 'unsupported_host' } });
  });

  it('rejects non-Azure remotes', () => {
    expect(
      resolveAzureDevOpsRepository('https://github.com/a/b', 'https://dev.azure.com/acme')
    ).toMatchObject({ success: false, error: { type: 'unsupported_host' } });
  });
});
