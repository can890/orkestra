import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeCreateWorktree } from '../create-worktree';
import { createRegistryGitContext } from '../git-context';
import { createPlatformCheckoutCloner, type CheckoutCloner } from './checkout-cloner';
import {
  createCacheGit,
  gitVersionSupported,
  namesFilter,
  parseGitVersion,
  WorktreeCheckoutCache,
  type CacheGit,
} from './worktree-checkout-cache';

// Hızlı checkout doğruluk testleri: önbellekten oluşturulan worktree, aynı commit'in
// normal checkout'uyla bayt bayt aynı olmalı (dosyalar, kipler, symlink'ler), `git status`
// temiz olmalı ve önbellek kaynağındaki yok sayılan/izlenmeyen dosyalar sızmamalı.

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

/** macOS'ta gerçek `clonefile`; başka platformlarda zaman damgalarını koruyan `cp -a`. */
function testCloner(): CheckoutCloner {
  const platform = createPlatformCheckoutCloner();
  if (platform) return platform;
  return async (pairs) => {
    for (const pair of pairs) {
      const ok = await new Promise<boolean>((resolve) =>
        execFile('cp', ['-a', pair.source, pair.destination], (error) => resolve(!error))
      );
      if (!ok) return false;
    }
    return true;
  };
}

const testGit: CacheGit = createCacheGit(async () => GIT_ENV);

type TreeEntry = { type: 'file' | 'symlink' | 'dir'; mode: number; content: string };

async function snapshotTree(root: string, relative = ''): Promise<Map<string, TreeEntry>> {
  const result = new Map<string, TreeEntry>();
  const directory = path.join(root, relative);
  for (const name of (await fs.readdir(directory)).sort()) {
    if (relative === '' && name === '.git') continue;
    const rel = relative ? `${relative}/${name}` : name;
    const full = path.join(root, rel);
    const info = await fs.lstat(full);
    if (info.isSymbolicLink()) {
      result.set(rel, { type: 'symlink', mode: 0, content: await fs.readlink(full) });
    } else if (info.isDirectory()) {
      result.set(rel, { type: 'dir', mode: 0, content: '' });
      for (const [key, value] of await snapshotTree(root, rel)) result.set(key, value);
    } else {
      result.set(rel, {
        type: 'file',
        mode: info.mode & 0o777,
        content: (await fs.readFile(full)).toString('base64'),
      });
    }
  }
  return result;
}

describe('WorktreeCheckoutCache', () => {
  let root: string;
  let repo: string;
  let cacheDir: string;
  let worktrees: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'checkout-cache-')));
    repo = path.join(root, 'repo');
    cacheDir = path.join(root, 'data', 'worktree-checkout-cache');
    worktrees = path.join(root, 'worktrees');
    await fs.mkdir(repo, { recursive: true });
    git(repo, 'init', '--initial-branch=main');
    await fs.mkdir(path.join(repo, 'src', 'nested'), { recursive: true });
    await fs.writeFile(path.join(repo, 'README.md'), '# repo\n');
    await fs.writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    await fs.writeFile(path.join(repo, 'src', 'nested', 'b.ts'), 'export const b = 2;\n');
    await fs.writeFile(path.join(repo, 'src', 'gone.ts'), 'to be deleted\n');
    await fs.writeFile(path.join(repo, 'run.sh'), '#!/bin/sh\necho hi\n');
    await fs.chmod(path.join(repo, 'run.sh'), 0o755);
    await fs.symlink('src/a.ts', path.join(repo, 'link-to-a'));
    await fs.writeFile(path.join(repo, '.gitignore'), 'dist/\n*.log\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'initial');
  });

  const caches: WorktreeCheckoutCache[] = [];

  afterEach(async () => {
    await Promise.all(caches.splice(0).map((cache) => cache.whenIdle()));
    await fs.rm(root, { recursive: true, force: true });
  });

  function makeCache(
    overrides: Partial<ConstructorParameters<typeof WorktreeCheckoutCache>[0]> = {}
  ) {
    const cache = new WorktreeCheckoutCache({
      cacheDir,
      cloner: testCloner(),
      git: testGit,
      homeDirectory: root,
      environment: { XDG_CONFIG_HOME: path.join(root, 'xdg') },
      ...overrides,
    });
    caches.push(cache);
    return cache;
  }

  async function create(cache: WorktreeCheckoutCache | null, name: string, baseRef = 'main') {
    const result = await executeCreateWorktree({
      git: createRegistryGitContext({ env: async () => GIT_ENV }),
      repositoryPath: repo,
      worktreePath: path.join(worktrees, name),
      branch: `task/${name}`,
      baseRef,
      onStage: () => undefined,
      checkoutCache: cache,
    });
    expect(result.status).toBe('succeeded');
    return path.join(worktrees, name);
  }

  async function bucketEntries(): Promise<string[]> {
    const buckets = await fs.readdir(cacheDir).catch(() => [] as string[]);
    const entries: string[] = [];
    for (const bucket of buckets) {
      for (const name of await fs.readdir(path.join(cacheDir, bucket)).catch(() => [])) {
        if (/^[0-9a-f]{40}-[0-9a-f]{16}$/u.test(name))
          entries.push(path.join(cacheDir, bucket, name));
      }
    }
    return entries;
  }

  /** Önbelleği doldurur: ilk worktree normal checkout kullanır ve arka planda önbelleği kurar. */
  async function primeCache(cache: WorktreeCheckoutCache): Promise<string> {
    const first = await create(cache, 'first');
    await cache.schedule(first, cache.currentGeneration());
    expect(await bucketEntries()).toHaveLength(1);
    return first;
  }

  it('reports the git version requirement and filter detection', () => {
    expect(gitVersionSupported(parseGitVersion('git version 2.42.0'))).toBe(true);
    expect(gitVersionSupported(parseGitVersion('git version 2.54.0 (Apple Git-157)'))).toBe(true);
    expect(gitVersionSupported(parseGitVersion('git version 2.41.9'))).toBe(false);
    expect(gitVersionSupported(parseGitVersion('git version 1.9.0'))).toBe(false);
    expect(gitVersionSupported(parseGitVersion(null))).toBe(false);
    expect(namesFilter('a.bin\0filter\0lfs\0a.bin\0diff\0lfs\0')).toBe(true);
    expect(namesFilter('a.txt\0text\0set\0')).toBe(false);
  });

  it('creates a worktree identical to a normal checkout of a later commit', async () => {
    const cache = makeCache();
    const first = await primeCache(cache);
    // Önbellek kaynağı olan ilk worktree'ye yok sayılan derleme çıktısı ve izlenmeyen dosya ekle.
    await fs.mkdir(path.join(first, 'dist'), { recursive: true });
    await fs.writeFile(path.join(first, 'dist', 'bundle.js'), 'built\n');
    await fs.writeFile(path.join(first, 'debug.log'), 'log\n');
    await fs.writeFile(path.join(first, 'untracked.txt'), 'stray\n');

    // Hedef commit: değişen, silinen, eklenen dosyalar ve kip değişikliği.
    await fs.writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 42;\n');
    await fs.rm(path.join(repo, 'src', 'gone.ts'));
    await fs.mkdir(path.join(repo, 'added', 'deep'), { recursive: true });
    await fs.writeFile(path.join(repo, 'added', 'deep', 'c.ts'), 'export const c = 3;\n');
    await fs.chmod(path.join(repo, 'src', 'nested', 'b.ts'), 0o755);
    await fs.symlink('../README.md', path.join(repo, 'added', 'readme-link'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'second');

    const createSpy = vi.spyOn(cache, 'create');
    const fast = await create(cache, 'fast');
    // Hızlı yol gerçekten kullanıldı (sessizce normal checkout'a düşmedi).
    expect(await createSpy.mock.results[0]!.value).toBe(true);
    const normal = await create(null, 'normal');

    expect(await snapshotTree(fast)).toEqual(await snapshotTree(normal));
    expect(git(fast, 'status', '--porcelain', '--ignored', '--untracked-files=all')).toBe('');
    expect(git(fast, 'rev-parse', 'HEAD')).toBe(git(normal, 'rev-parse', 'HEAD'));
    expect(git(fast, 'branch', '--show-current')).toBe('task/fast');
    await expect(fs.stat(path.join(fast, 'dist'))).rejects.toThrow();
    await expect(fs.stat(path.join(fast, 'untracked.txt'))).rejects.toThrow();
    // İlk `git status` index'i yeniden yazmak zorunda kalmamalı: stat verisi zaten doğru.
    const indexPath = git(fast, 'rev-parse', '--git-path', 'index');
    const before = await fs.readFile(path.resolve(fast, indexPath));
    git(fast, 'status', '--porcelain');
    const after = await fs.readFile(path.resolve(fast, indexPath));
    expect(after.equals(before)).toBe(true);
  });

  it('creates from an existing branch at the cached commit', async () => {
    const cache = makeCache();
    await primeCache(cache);
    git(repo, 'branch', 'feature/existing', 'main');
    const createSpy = vi.spyOn(cache, 'create');
    const result = await executeCreateWorktree({
      git: createRegistryGitContext({ env: async () => GIT_ENV }),
      repositoryPath: repo,
      worktreePath: path.join(worktrees, 'existing'),
      branch: 'feature/existing',
      baseRef: 'main',
      onStage: () => undefined,
      checkoutCache: cache,
    });
    expect(result).toMatchObject({ status: 'succeeded', createdBranch: false });
    expect(await createSpy.mock.results[0]!.value).toBe(true);
    const fast = path.join(worktrees, 'existing');
    const normal = await create(null, 'normal');
    expect(await snapshotTree(fast)).toEqual(await snapshotTree(normal));
    expect(git(fast, 'status', '--porcelain', '--ignored')).toBe('');
  });

  it('dry primitive: create() returns false with an empty cache (first worktree)', async () => {
    const cache = makeCache();
    expect(
      await cache.create({ cwd: repo, worktreePath: path.join(worktrees, 'x'), refName: 'main' })
    ).toBe(false);
    await expect(fs.stat(path.join(worktrees, 'x'))).rejects.toThrow();
  });

  it('falls back on non-macOS platforms (no cloner)', async () => {
    const cache = makeCache({ cloner: undefined });
    expect(cache.supported).toBe(false);
    const created = await create(cache, 'plain');
    await cache.schedule(created, cache.currentGeneration());
    expect(await bucketEntries()).toHaveLength(0);
    expect(createPlatformCheckoutCloner('linux')).toBeUndefined();
    expect(createPlatformCheckoutCloner('win32')).toBeUndefined();
  });

  it('falls back on git older than 2.42', async () => {
    const oldGit: CacheGit = async (cwd, args, options) =>
      args[0] === 'version' ? 'git version 2.41.0\n' : await testGit(cwd, args, options);
    const priming = makeCache();
    await primeCache(priming);
    const cache = makeCache({ git: oldGit });
    expect(
      await cache.create({ cwd: repo, worktreePath: path.join(worktrees, 'old'), refName: 'main' })
    ).toBe(false);
    await cache.build(path.join(worktrees, 'first'), cache.currentGeneration());
  });

  it('falls back when the worktree is on a different volume than the cache', async () => {
    await primeCache(makeCache());
    let calls = 0;
    const cache = makeCache({ deviceOf: async () => ++calls });
    expect(
      await cache.create({ cwd: repo, worktreePath: path.join(worktrees, 'vol'), refName: 'main' })
    ).toBe(false);
    await expect(fs.stat(path.join(worktrees, 'vol'))).rejects.toThrow();
  });

  it('falls back for sparse checkouts', async () => {
    const cache = makeCache();
    await primeCache(cache);
    git(repo, 'config', 'core.sparseCheckout', 'true');
    expect(
      await cache.create({
        cwd: repo,
        worktreePath: path.join(worktrees, 'sparse'),
        refName: 'main',
        newBranch: 'task/sparse',
      })
    ).toBe(false);
    // Geri alma: yarım worktree ve açılan dal kalmamalı.
    await expect(fs.stat(path.join(worktrees, 'sparse'))).rejects.toThrow();
    expect(git(repo, 'branch', '--list', 'task/sparse')).toBe('');
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('sparse');
  });

  it('never caches trees whose attributes use filters such as Git LFS', async () => {
    await fs.writeFile(
      path.join(repo, '.gitattributes'),
      '*.bin filter=lfs diff=lfs merge=lfs -text\n'
    );
    await fs.writeFile(path.join(repo, 'blob.bin'), 'binary\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'lfs attributes');
    const cache = makeCache();
    const first = await create(cache, 'first');
    await cache.schedule(first, cache.currentGeneration());
    expect(await bucketEntries()).toHaveLength(0);
    expect(
      await cache.create({ cwd: repo, worktreePath: path.join(worktrees, 'lfs'), refName: 'main' })
    ).toBe(false);
  });

  it('falls back when checkout settings changed since the cache was built', async () => {
    const cache = makeCache();
    await primeCache(cache);
    git(repo, 'config', 'core.autocrlf', 'input');
    expect(
      await cache.create({
        cwd: repo,
        worktreePath: path.join(worktrees, 'crlf'),
        refName: 'main',
        newBranch: 'task/crlf',
      })
    ).toBe(false);
    await expect(fs.stat(path.join(worktrees, 'crlf'))).rejects.toThrow();
  });

  it('rolls back and falls back to a normal checkout when cloning fails', async () => {
    const cache = makeCache();
    await primeCache(cache);
    const failing = makeCache({ cloner: async () => false });
    const created = await create(failing, 'after-failure');
    expect(git(created, 'status', '--porcelain')).toBe('');
    expect(git(created, 'branch', '--show-current')).toBe('task/after-failure');
    expect(await snapshotTree(created)).toEqual(await snapshotTree(path.join(worktrees, 'first')));
  });

  it('discards a cache entry whose files changed after git wrote them', async () => {
    const cache = makeCache();
    await primeCache(cache);
    const [entry] = await bucketEntries();
    await fs.appendFile(path.join(entry!, 'files', 'README.md'), 'tampered\n');
    expect(
      await cache.create({
        cwd: repo,
        worktreePath: path.join(worktrees, 'tampered'),
        refName: 'main',
        newBranch: 'task/tampered',
      })
    ).toBe(false);
    expect(await bucketEntries()).toHaveLength(0);
    const created = await create(cache, 'after-tamper');
    expect(await fs.readFile(path.join(created, 'README.md'), 'utf8')).toBe('# repo\n');
  });

  it('discards a cache entry that gained a stray file', async () => {
    const cache = makeCache();
    await primeCache(cache);
    const [entry] = await bucketEntries();
    await fs.writeFile(path.join(entry!, 'files', 'src', 'stray.txt'), 'stray\n');
    const created = await create(cache, 'stray');
    await expect(fs.stat(path.join(created, 'src', 'stray.txt'))).rejects.toThrow();
    expect(git(created, 'status', '--porcelain', '--ignored')).toBe('');
  });

  it('clear() deletes the cache and stops in-flight builds from publishing', async () => {
    const cache = makeCache();
    const first = await create(cache, 'first');
    const generation = cache.currentGeneration();
    await cache.clear();
    await cache.build(first, generation).catch(() => undefined);
    expect(await bucketEntries()).toHaveLength(0);
    await cache.schedule(first, cache.currentGeneration());
    expect(await bucketEntries()).toHaveLength(1);
    await cache.clear();
    await expect(fs.stat(cacheDir)).rejects.toThrow();
  });
});
