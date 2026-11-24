import { describe, expect, it } from 'vitest';
import {
  isBitbucketCloudHost,
  parseBitbucketRemote,
  resolveBitbucketCloudRepository,
} from './remote';

describe('parseBitbucketRemote', () => {
  it.each([
    ['https://bitbucket.org/acme/web.git', 'acme', 'web'],
    ['https://bitbucket.org/acme/web', 'acme', 'web'],
    ['https://ada@bitbucket.org/acme/web.git', 'acme', 'web'],
    ['https://www.bitbucket.org/acme/web/', 'acme', 'web'],
    ['git@bitbucket.org:acme/web.git', 'acme', 'web'],
    ['git@bitbucket.org:acme/web', 'acme', 'web'],
    ['ssh://git@bitbucket.org/acme/web.git', 'acme', 'web'],
    ['ssh://git@altssh.bitbucket.org:443/acme/web.git', 'acme', 'web'],
    ['https://altssh.bitbucket.org/acme/web', 'acme', 'web'],
    ['https://bitbucket.org/acme/web/src/main/README.md', 'acme', 'web'],
    ['https://bitbucket.org/acme/web/pull-requests/12', 'acme', 'web'],
    ['https://BitBucket.org/Acme/My.Repo.git', 'Acme', 'My.Repo'],
  ])('parses Bitbucket Cloud remote %s', (remote, workspace, repoSlug) => {
    expect(parseBitbucketRemote(remote)).toEqual({
      deployment: 'cloud',
      host: 'bitbucket.org',
      workspace,
      repoSlug,
      fullName: `${workspace}/${repoSlug}`,
    });
  });

  it.each([
    ['https://bitbucket.example.com/scm/PROJ/web.git', 'PROJ', 'web'],
    ['https://bitbucket.example.com/context/scm/PROJ/web.git', 'PROJ', 'web'],
    ['https://bitbucket.example.com/scm/~ada/dotfiles.git', '~ada', 'dotfiles'],
    ['ssh://git@bitbucket.example.com:7999/proj/web.git', 'proj', 'web'],
    ['https://bitbucket.example.com/projects/PROJ/repos/web/browse', 'PROJ', 'web'],
    ['https://bitbucket.example.com/users/ada/repos/dotfiles/browse', '~ada', 'dotfiles'],
  ])('recognises Bitbucket Data Center remote %s', (remote, projectKey, repoSlug) => {
    expect(parseBitbucketRemote(remote)).toEqual({
      deployment: 'data-center',
      host: 'bitbucket.example.com',
      projectKey,
      repoSlug,
    });
  });

  it.each([
    '',
    'not a url',
    'https://github.com/acme/web.git',
    'git@gitlab.com:acme/web.git',
    'https://bitbucket.org/acme',
    'ftp://bitbucket.org/acme/web',
    'https://notbitbucket.org/acme/web',
  ])('rejects %j', (remote) => {
    expect(parseBitbucketRemote(remote)).toBeNull();
  });

  it('identifies Cloud hosts including SSH aliases', () => {
    expect(isBitbucketCloudHost('bitbucket.org')).toBe(true);
    expect(isBitbucketCloudHost('altssh.bitbucket.org')).toBe(true);
    expect(isBitbucketCloudHost('bitbucket.example.com')).toBe(false);
    expect(isBitbucketCloudHost('evilbitbucket.org')).toBe(false);
  });
});

describe('resolveBitbucketCloudRepository', () => {
  it('requires a repository URL', () => {
    expect(resolveBitbucketCloudRepository(undefined)).toMatchObject({
      success: false,
      error: { type: 'invalid_input' },
    });
  });

  it('rejects Data Center remotes with an explicit message', () => {
    const result = resolveBitbucketCloudRepository(
      'https://bitbucket.example.com/scm/PROJ/web.git'
    );
    expect(result).toMatchObject({ success: false, error: { type: 'unsupported_host' } });
    if (result.success) throw new Error('unreachable');
    expect(result.error.message).toContain('Data Center');
  });

  it('rejects other hosts', () => {
    expect(resolveBitbucketCloudRepository('https://github.com/a/b')).toMatchObject({
      success: false,
      error: { type: 'unsupported_host' },
    });
  });
});
