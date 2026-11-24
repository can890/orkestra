// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/storageCleanup.ts,
// apps/server/src/vcs/worktreeRemoval.ts, apps/server/src/vcs/removeEmptyDirectory.ts
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CleanupGit } from './git';

/** `parent` altında (kendisi değil) mi; ikisi de gerçek yol olmalı. */
export function isStrictlyInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export async function realpathOrNull(target: string): Promise<string | null> {
  return await fs.realpath(target).catch(() => null);
}

/** Yönetilen kökleri gerçek yollarına çözer; var olmayanlar düşer. */
export async function resolveManagedRoots(roots: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(roots.map((root) => realpathOrNull(path.resolve(root))));
  return [...new Set(resolved.filter((root): root is string => root !== null))];
}

export type PathSafety = { ok: true; realPath: string } | { ok: false; reason: string };

/**
 * Yol güvenliği: worktree klasörünün kendisi symlink olamaz (üst klasörler olabilir),
 * gerçek yolu Orkestra'nın yönettiği bir worktree kökünün içinde olmalı, bağlı bir
 * worktree olmalı (`.git` bir dosya) ve projenin ana checkout'u olmamalı.
 */
export async function checkWorktreePath(input: {
  worktreePath: string;
  managedRoots: readonly string[];
  repositoryPath: string | null;
}): Promise<PathSafety> {
  const target = path.resolve(input.worktreePath);
  const info = await fs.lstat(target).catch(() => null);
  if (info === null) return { ok: false, reason: 'worktree folder is missing' };
  if (info.isSymbolicLink()) return { ok: false, reason: 'worktree is a symbolic link' };
  if (!info.isDirectory()) return { ok: false, reason: 'worktree is not a folder' };
  const realPath = await realpathOrNull(target);
  const realParent = await realpathOrNull(path.dirname(target));
  if (realPath === null || realParent === null) {
    return { ok: false, reason: 'worktree path could not be resolved' };
  }
  if (realPath !== path.join(realParent, path.basename(target))) {
    return { ok: false, reason: 'worktree is a symbolic link' };
  }
  if (!input.managedRoots.some((root) => isStrictlyInside(root, realPath))) {
    return { ok: false, reason: 'outside the Orkestra worktree folders' };
  }
  if (input.repositoryPath !== null) {
    const repository = await realpathOrNull(input.repositoryPath);
    if (repository !== null) {
      if (repository === realPath) return { ok: false, reason: 'main checkout of the project' };
      if (isStrictlyInside(realPath, repository)) {
        return { ok: false, reason: 'contains a project checkout' };
      }
    }
  }
  const gitEntry = await fs.lstat(path.join(realPath, '.git')).catch(() => null);
  if (gitEntry === null || !gitEntry.isFile()) {
    return { ok: false, reason: 'not a linked worktree' };
  }
  return { ok: true, realPath };
}

/** Bağlı worktree'nin ana checkout'u (`git worktree list`'in ilk girdisi). */
export async function mainCheckoutOf(
  git: CleanupGit,
  worktreePath: string
): Promise<string | null> {
  const result = await git(worktreePath, ['worktree', 'list', '--porcelain']);
  if (result.code !== 0) return null;
  const first = result.stdout.split('\n').find((line) => line.startsWith('worktree '));
  return first ? first.slice('worktree '.length) : null;
}

export async function currentBranch(git: CleanupGit, cwd: string): Promise<string | null> {
  const result = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

export async function headCommit(git: CleanupGit, cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

/**
 * Yerel değişiklik nedeni: izlenen düzenlemeler ve izlenmeyen dosyalar korunur (yok
 * sayılan `.env`, derleme çıktısı gibi dosyalar korunmaz — T3'ün "Uncommitted changes"
 * varsayılanı). Süren bir merge/rebase de korunur. Temizse null.
 */
export async function localChangesReason(git: CleanupGit, cwd: string): Promise<string | null> {
  const status = await git(cwd, [
    '-c',
    'status.showUntrackedFiles=all',
    'status',
    '--porcelain=v1',
    '-z',
    '--ignore-submodules=none',
    '--untracked-files=all',
  ]);
  if (status.code !== 0) return 'local changes could not be inspected';
  const records = status.stdout.split('\0').filter(Boolean);
  let count = 0;
  for (let index = 0; index < records.length; index++) {
    count++;
    // Yeniden adlandırma/kopya kayıtları kaynak yolu ayrı bir alan olarak taşır.
    if (/^[RC]|^.[RC]/u.test(records[index]!)) index++;
  }
  if (count > 0) return `has uncommitted changes (${count} ${count === 1 ? 'file' : 'files'})`;
  const gitDir = await git(cwd, ['rev-parse', '--absolute-git-dir']);
  if (gitDir.code !== 0) return 'local changes could not be inspected';
  const dir = gitDir.stdout.trim();
  for (const marker of [
    'MERGE_HEAD',
    'REBASE_HEAD',
    'rebase-merge',
    'rebase-apply',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
  ]) {
    if (
      await fs.lstat(path.join(dir, marker)).then(
        () => true,
        () => false
      )
    ) {
      return 'has a git operation in progress';
    }
  }
  return null;
}

export async function listRemotes(git: CleanupGit, cwd: string): Promise<string[]> {
  const result = await git(cwd, ['remote']);
  return result.code === 0
    ? result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

/** Hiçbir uzak izleme dalında olmayan commit sayısı (uzak yoksa 0). */
export async function unpushedCommitCount(
  git: CleanupGit,
  cwd: string,
  remotes: readonly string[]
): Promise<number | null> {
  if (remotes.length === 0) return 0;
  const result = await git(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
  if (result.code !== 0) return null;
  const count = Number(result.stdout.trim());
  return Number.isFinite(count) ? count : null;
}

/**
 * Karşılaştırılacak varsayılan dal: uzak varsa `origin` (yoksa ilk uzak) için
 * `refs/remotes/<uzak>/HEAD`'in işaret ettiği dal, yoksa `main`/`master`. Uzak yoksa
 * projenin ana checkout'unda checkout edilmiş dal; ayrık HEAD'de null (worktree korunur).
 * Ağa çıkılmaz: yerel uzak izleme referansları kullanılır.
 */
export async function defaultBranchRef(
  git: CleanupGit,
  repositoryPath: string,
  remotes: readonly string[]
): Promise<{ ref: string; label: string } | null> {
  if (remotes.length === 0) {
    const head = await git(repositoryPath, ['symbolic-ref', '--quiet', 'HEAD']);
    if (head.code !== 0) return null;
    const ref = head.stdout.trim();
    return ref ? { ref, label: 'the project branch' } : null;
  }
  const remote = remotes.includes('origin') ? 'origin' : remotes[0]!;
  const symbolic = await git(repositoryPath, [
    'symbolic-ref',
    '--quiet',
    `refs/remotes/${remote}/HEAD`,
  ]);
  if (symbolic.code === 0 && symbolic.stdout.trim()) {
    return { ref: symbolic.stdout.trim(), label: 'the default branch' };
  }
  for (const name of ['main', 'master']) {
    const ref = `refs/remotes/${remote}/${name}`;
    const exists = await git(repositoryPath, ['show-ref', '--verify', '--quiet', ref]);
    if (exists.code === 0) return { ref, label: 'the default branch' };
  }
  return null;
}

export async function isAncestor(
  git: CleanupGit,
  cwd: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  return (await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
}

/**
 * Dalın oluşturulduğundan beri kendi commit'i var mı: dal reflog'unun ilk kaydından
 * (oluşturma) HEAD'e kadar commit sayısı. Reflog yoksa null (birleşme kuralı uygulanmaz).
 */
export async function branchHasOwnCommits(
  git: CleanupGit,
  cwd: string,
  branch: string
): Promise<boolean | null> {
  const reflog = await git(cwd, ['reflog', 'show', '--format=%H', `refs/heads/${branch}`, '--']);
  if (reflog.code !== 0) return null;
  const lines = reflog.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const created = lines.at(-1);
  if (!created) return null;
  const count = await git(cwd, ['rev-list', '--count', `${created}..HEAD`]);
  if (count.code !== 0) return null;
  return Number(count.stdout.trim()) > 0;
}

/**
 * Worktree'yi `git worktree remove` ile kaldırır (zorlamasız): Git kendi denetimlerini
 * de uygular — değiştirilmiş/izlenmeyen dosyası olan, kilitli ya da submodule içeren
 * worktree'yi reddeder — ve worktree meta verisi tutarlı kalır. Dal silinmez.
 */
export async function removeLinkedWorktree(
  git: CleanupGit,
  mainCheckout: string,
  worktreePath: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Git'in izlenmeyen dosya denetimi `status.showUntrackedFiles=no` ayarına uyar; açıkça normal yap.
  const result = await git(mainCheckout, [
    '-c',
    'status.showUntrackedFiles=normal',
    'worktree',
    'remove',
    '--',
    worktreePath,
  ]);
  if (result.code === 0) return { ok: true };
  const detail = (result.stderr || result.stdout).split(/\r?\n/u).find(Boolean) ?? 'failed';
  return { ok: false, reason: `git worktree remove: ${detail}` };
}

/** `target` yalnızca boş bir klasörse kaldırır; başka bir şey varsa false. */
export async function removeEmptyDirectory(target: string): Promise<boolean> {
  try {
    await fs.rmdir(target);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOENT') return false;
    throw error;
  }
}

/** Disk kullanımı (bayt), `du -sk` ile; ölçülemezse null. Sembolik bağları izlemez. */
export function measureDiskUsage(target: string, timeoutMs = 60_000): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'du',
      ['-sk', target],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const kb = Number(String(stdout ?? '').split(/\s+/u)[0]);
        if (Number.isFinite(kb) && String(stdout ?? '').trim() !== '') {
          resolve(kb * 1024);
          return;
        }
        resolve(error ? null : 0);
      }
    );
  });
}
