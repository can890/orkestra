/**
 * Hızlı worktree checkout kıyaslaması (CI'da çalışmaz, elle çalıştırılır).
 *
 * Geçici bir klasörde orta boy sentetik bir depo üretir, ardından aynı commit için
 * normal `git worktree add` ile APFS copy-on-write önbellek yolunu karşılaştırır:
 * oluşturma süresi ve ilk `git status` süresi. Önbellek bir önceki commit'ten
 * kurulduğu için hızlı yol ayrıca `read-tree -m -u` ile hedefe uzlaştırmayı da ölçer.
 *
 * Çalıştırma (depo kökünden, yalnız macOS'ta anlamlıdır):
 *   pnpm --dir apps/orkestra-desktop exec tsx tooling/benchmarks/fast-worktree-checkout.ts \
 *     [--files 20000] [--changed 50] [--runs 3]
 *
 * Yalnızca `os.tmpdir()` altında yazar ve sonunda her şeyi siler.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createPlatformCheckoutCloner } from '../../../../packages/core/src/runtimes/workspace-registry/node/checkout-cache/checkout-cloner';
import { WorktreeCheckoutCache } from '../../../../packages/core/src/runtimes/workspace-registry/node/checkout-cache/worktree-checkout-cache';

function flag(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const FILES = flag('files', 20_000);
const CHANGED = flag('changed', 50);
const RUNS = flag('runs', 3);

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Bench',
  GIT_AUTHOR_EMAIL: 'bench@example.com',
  GIT_COMMITTER_NAME: 'Bench',
  GIT_COMMITTER_EMAIL: 'bench@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function main(): Promise<void> {
  const cloner = createPlatformCheckoutCloner();
  if (!cloner) {
    console.log('Fast worktree checkout needs macOS (APFS clonefile); nothing to measure.');
    return;
  }
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fast-checkout-bench-')));
  try {
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    git(repo, 'init', '--initial-branch=main', '--quiet');
    const perDir = 40;
    for (let index = 0; index < FILES; index++) {
      const dir = path.join(
        repo,
        `pkg${Math.floor(index / (perDir * 25))}`,
        `mod${Math.floor(index / perDir)}`
      );
      if (index % perDir === 0) await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, `file${index}.ts`),
        `export const value${index} = ${index};\n`.repeat(20)
      );
    }
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'initial', '--quiet');

    const cache = new WorktreeCheckoutCache({
      cacheDir: path.join(root, 'cache'),
      cloner,
    });
    // Önbelleği ilk commit'ten doldur.
    const seed = path.join(root, 'seed');
    git(repo, 'worktree', 'add', '--quiet', '-b', 'seed', seed, 'main');
    await cache.build(seed, cache.currentGeneration());

    // Hedef commit: CHANGED dosya değişir.
    for (let index = 0; index < CHANGED; index++) {
      const file = path.join(
        repo,
        `pkg${Math.floor(index / (perDir * 25))}`,
        `mod${Math.floor(index / perDir)}`,
        `file${index}.ts`
      );
      await fs.appendFile(file, '// changed\n');
    }
    git(repo, 'commit', '-am', 'change', '--quiet');

    const normal: number[] = [];
    const normalStatus: number[] = [];
    const fast: number[] = [];
    const fastStatus: number[] = [];
    let fastUsed = 0;
    for (let run = 0; run < RUNS; run++) {
      const normalPath = path.join(root, `normal-${run}`);
      let start = performance.now();
      git(
        repo,
        'worktree',
        'add',
        '--quiet',
        '--no-track',
        '-b',
        `normal-${run}`,
        normalPath,
        'main'
      );
      normal.push(performance.now() - start);
      start = performance.now();
      git(normalPath, 'status', '--porcelain');
      normalStatus.push(performance.now() - start);

      const fastPath = path.join(root, `fast-${run}`);
      start = performance.now();
      const used = await cache.create({
        cwd: repo,
        worktreePath: fastPath,
        refName: 'main',
        newBranch: `fast-${run}`,
      });
      if (!used)
        git(
          repo,
          'worktree',
          'add',
          '--quiet',
          '--no-track',
          '-b',
          `fast-${run}`,
          fastPath,
          'main'
        );
      fast.push(performance.now() - start);
      if (used) fastUsed++;
      start = performance.now();
      const status = git(fastPath, 'status', '--porcelain');
      fastStatus.push(performance.now() - start);
      if (status !== '') throw new Error(`fast worktree is not clean:\n${status}`);
    }

    const fmt = (ms: number) => `${ms.toFixed(0)} ms`;
    console.log(
      `Repository: ${FILES} tracked files, target differs from cache by ${CHANGED} files`
    );
    console.log(`Runs: ${RUNS} (fast path used ${fastUsed}/${RUNS})`);
    console.log(`git worktree add       median ${fmt(median(normal))}`);
    console.log(`fast (clone+reconcile) median ${fmt(median(fast))}`);
    console.log(`first git status, normal median ${fmt(median(normalStatus))}`);
    console.log(`first git status, fast   median ${fmt(median(fastStatus))}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

await main();
