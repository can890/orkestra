import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverRepositories,
  isSafeRelativeRepositoryPath,
  parseGitConfigRemotes,
  parseGitmodulesPaths,
  readRepositoryHeadInfo,
} from '../discovery';
import {
  nestedRepositoryWorkspaceId,
  parseNestedRepositoryWorkspaceId,
} from '../nested-repository-id';
import { createLocalDiscoveryFs } from './local-discovery-fs';

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'orkestra-repo-discovery-')));
  cleanups.push(dir);
  return dir;
}

/** `.git` dizini olan sahte depo (keşif yalnızca varlığına bakar). */
async function fakeRepo(dir: string, options: { branch?: string; remote?: string } = {}) {
  await mkdir(path.join(dir, '.git'), { recursive: true });
  await writeFile(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${options.branch ?? 'main'}\n`);
  await writeFile(
    path.join(dir, '.git', 'config'),
    options.remote ? `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${options.remote}\n` : ''
  );
}

async function linkedCheckout(dir: string, gitDir: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '.git'), `gitdir: ${gitDir}\n`);
}

const fs = createLocalDiscoveryFs();
const relativePaths = (result: Awaited<ReturnType<typeof discoverRepositories>>) =>
  result.repositories.map((repository) => `${repository.kind}:${repository.relativePath}`);

describe('discoverRepositories', () => {
  it('finds the repositories of a plain folder', async () => {
    const root = await tempRoot();
    await fakeRepo(path.join(root, 'web'));
    await fakeRepo(path.join(root, 'api'));
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'README.md'), '# shop\n');

    const result = await discoverRepositories(fs, root);

    expect(result.rootIsRepository).toBe(false);
    expect(result.truncated).toBe(false);
    expect(relativePaths(result)).toEqual(['repository:api', 'repository:web']);
    expect(result.repositories[0]).toMatchObject({ name: 'api', path: path.join(root, 'api') });
  });

  it('looks one level further inside folders that are not repositories', async () => {
    const root = await tempRoot();
    await fakeRepo(path.join(root, 'packages', 'core'));
    await fakeRepo(path.join(root, 'packages', 'ui'));
    await fakeRepo(path.join(root, 'services'));

    const result = await discoverRepositories(fs, root);

    expect(relativePaths(result)).toEqual([
      'repository:packages/core',
      'repository:packages/ui',
      'repository:services',
    ]);
  });

  it('stops at the depth limits', async () => {
    const root = await tempRoot();
    // Üç seviye derinlik: bulunmaz.
    await fakeRepo(path.join(root, 'a', 'b', 'c'));
    // Bir deponun içindeki depo deponundur: ayrıca listelenmez.
    await fakeRepo(path.join(root, 'outer'));
    await fakeRepo(path.join(root, 'outer', 'inner'));

    const result = await discoverRepositories(fs, root);

    expect(relativePaths(result)).toEqual(['repository:outer']);
  });

  it('skips dot folders and node_modules', async () => {
    const root = await tempRoot();
    await fakeRepo(path.join(root, '.cache', 'repo'));
    await fakeRepo(path.join(root, '.hidden'));
    await fakeRepo(path.join(root, 'node_modules', 'pkg'));
    await fakeRepo(path.join(root, 'app'));

    expect(relativePaths(await discoverRepositories(fs, root))).toEqual(['repository:app']);
  });

  it('leaves out worktrees of another repository', async () => {
    const root = await tempRoot();
    await fakeRepo(path.join(root, 'main-repo'));
    await linkedCheckout(
      path.join(root, 'feature-wt'),
      path.join(root, 'main-repo', '.git', 'worktrees', 'feature-wt')
    );
    await linkedCheckout(
      path.join(root, 'nested', 'wt'),
      path.join(root, 'main-repo', '.git', 'worktrees', 'wt')
    );

    expect(relativePaths(await discoverRepositories(fs, root))).toEqual(['repository:main-repo']);
  });

  it('lists initialized submodules of the root repository and of found repositories', async () => {
    const root = await tempRoot();
    await fakeRepo(root);
    await writeFile(
      path.join(root, '.gitmodules'),
      '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = ../lib.git\n' +
        '[submodule "missing"]\n\tpath = missing\n\turl = ../missing.git\n' +
        '[submodule "escape"]\n\tpath = ../escape\n\turl = ../escape.git\n'
    );
    await linkedCheckout(path.join(root, 'vendor', 'lib'), path.join(root, '.git/modules/lib'));
    // Başlatılmamış alt modül boş bir klasördür.
    await mkdir(path.join(root, 'missing'));
    await fakeRepo(path.join(root, 'tools'));
    await writeFile(
      path.join(root, 'tools', '.gitmodules'),
      '[submodule "deps/x"]\n\tpath = deps/x\n\turl = ../x.git\n'
    );
    await linkedCheckout(
      path.join(root, 'tools', 'deps', 'x'),
      path.join(root, 'tools', '.git', 'modules', 'x')
    );

    const result = await discoverRepositories(fs, root);

    expect(result.rootIsRepository).toBe(true);
    expect(relativePaths(result)).toEqual([
      'submodule:vendor/lib',
      'repository:tools',
      'submodule:tools/deps/x',
    ]);
  });

  it('keeps symlinked repositories inside the project once and drops ones outside it', async () => {
    const outside = await tempRoot();
    await fakeRepo(path.join(outside, 'elsewhere'));
    const root = await tempRoot();
    await fakeRepo(path.join(root, 'real'));
    await symlink(path.join(root, 'real'), path.join(root, 'alias'), 'dir');
    await symlink(path.join(outside, 'elsewhere'), path.join(root, 'external'), 'dir');
    await mkdir(path.join(root, 'group'));
    await symlink(path.join(outside, 'elsewhere'), path.join(root, 'group', 'linked'), 'dir');

    const result = await discoverRepositories(fs, root);

    expect(relativePaths(result)).toEqual(['repository:real']);
  });

  it('caps the number of repositories and reports truncation', async () => {
    const root = await tempRoot();
    for (const name of ['a', 'b', 'c', 'd']) await fakeRepo(path.join(root, name));

    const result = await discoverRepositories(fs, root, { limit: 2 });

    expect(relativePaths(result)).toEqual(['repository:a', 'repository:b']);
    expect(result.truncated).toBe(true);
  });

  it('returns nothing for a missing folder', async () => {
    const root = await tempRoot();
    const result = await discoverRepositories(fs, path.join(root, 'nope'));
    expect(result).toMatchObject({ rootIsRepository: false, repositories: [], truncated: false });
  });
});

describe('readRepositoryHeadInfo', () => {
  it('reads the branch and remotes of a repository', async () => {
    const root = await tempRoot();
    await fakeRepo(path.join(root, 'api'), {
      branch: 'feature/x',
      remote: 'git@example.com:shop/api.git',
    });

    await expect(readRepositoryHeadInfo(fs, path.join(root, 'api'))).resolves.toEqual({
      branch: 'feature/x',
      detachedAt: null,
      remotes: [{ name: 'origin', url: 'git@example.com:shop/api.git' }],
    });
  });

  it('follows a gitdir pointer and commondir for linked checkouts', async () => {
    const root = await tempRoot();
    await fakeRepo(path.join(root, 'main'), { remote: 'https://example.com/main.git' });
    const worktreeGitDir = path.join(root, 'main', '.git', 'worktrees', 'wt');
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(
      path.join(worktreeGitDir, 'HEAD'),
      'abcdef0123456789abcdef0123456789abcdef01\n'
    );
    await writeFile(path.join(worktreeGitDir, 'commondir'), '../..\n');
    await linkedCheckout(path.join(root, 'wt'), worktreeGitDir);

    await expect(readRepositoryHeadInfo(fs, path.join(root, 'wt'))).resolves.toEqual({
      branch: null,
      detachedAt: 'abcdef0',
      remotes: [{ name: 'origin', url: 'https://example.com/main.git' }],
    });
  });
});

describe('parsers', () => {
  it('parses .gitmodules paths', () => {
    expect(
      parseGitmodulesPaths(
        '[submodule "a"]\n  path = "libs\\a/"\n  url = x\n[submodule "b"]\npath=b\n'
      )
    ).toEqual(['libs/a', 'b']);
  });

  it('parses remotes from git config', () => {
    expect(
      parseGitConfigRemotes(
        '[remote "origin"]\n\turl = https://a\n\turl = https://ignored\n[branch "main"]\n\tremote = origin\n[remote "up"]\n\turl = git@b\n'
      )
    ).toEqual([
      { name: 'origin', url: 'https://a' },
      { name: 'up', url: 'git@b' },
    ]);
  });

  it('accepts only safe relative repository paths', () => {
    expect(isSafeRelativeRepositoryPath('api')).toBe(true);
    expect(isSafeRelativeRepositoryPath('packages/web')).toBe(true);
    for (const bad of ['', '/abs', '../up', 'a/../b', 'a//b', './a', 'a\\b', 'C:/x']) {
      expect(isSafeRelativeRepositoryPath(bad)).toBe(false);
    }
  });

  it('round-trips nested repository workspace ids', () => {
    const id = nestedRepositoryWorkspaceId('ws-1', 'packages/web');
    expect(parseNestedRepositoryWorkspaceId(id)).toEqual({
      workspaceId: 'ws-1',
      relativePath: 'packages/web',
    });
    expect(parseNestedRepositoryWorkspaceId('ws-1')).toBeNull();
    expect(parseNestedRepositoryWorkspaceId('ws-1::repo::../x')).toBeNull();
    expect(parseNestedRepositoryWorkspaceId('::repo::x')).toBeNull();
  });
});
