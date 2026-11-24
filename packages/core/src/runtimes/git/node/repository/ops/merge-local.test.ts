import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindGitDir } from '#runtimes/git/node/exec/git-exec';
import { createBoundExec } from '#services/exec/api';
import { mergeLocalBranch } from './merge-local';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setupRepoWithWorktree() {
  const root = await mkdtemp(path.join(tmpdir(), 'orkestra-merge-local-'));
  tempDirs.push(root);
  const repoDir = path.join(root, 'repo');
  const wtDir = path.join(root, 'wt-feat');

  const exec = createBoundExec({ file: 'git', cwd: root, env: process.env });
  await exec.exec(['init', '-b', 'main', repoDir]);
  const mainExec = exec.withCwd(repoDir);
  await mainExec.exec(['config', 'user.email', 'test@orkestra.local']);
  await mainExec.exec(['config', 'user.name', 'Test User']);
  await writeFile(path.join(repoDir, 'base.txt'), 'base\n', 'utf8');
  await mainExec.exec(['add', 'base.txt']);
  await mainExec.exec(['commit', '-m', 'init main']);
  await mainExec.exec(['worktree', 'add', '-b', 'feat/demo', wtDir, 'main']);

  const wtExec = exec.withCwd(wtDir);
  const repoGitExec = bindGitDir(exec, path.join(repoDir, '.git'));
  return { repoDir, wtDir, mainExec, wtExec, repoGitExec };
}

describe('mergeLocalBranch', () => {
  it('squash merges feature branch into main cleanly from worktree', async () => {
    const { repoDir, wtDir, mainExec, wtExec, repoGitExec } = await setupRepoWithWorktree();
    await writeFile(path.join(wtDir, 'feature.txt'), 'one\n', 'utf8');
    await wtExec.exec(['add', 'feature.txt']);
    await wtExec.exec(['commit', '-m', 'step 1']);
    await writeFile(path.join(wtDir, 'feature.txt'), 'one\ntwo\n', 'utf8');
    await wtExec.exec(['add', 'feature.txt']);
    await wtExec.exec(['commit', '-m', 'step 2']);

    const result = await mergeLocalBranch(repoGitExec, {
      sourceBranch: 'feat/demo',
      targetBranch: 'main',
      strategy: 'squash',
      commitMessage: 'Özellik eklendi',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ kind: 'merged', mergedCommits: 2 });
    }
    const { stdout: logOut } = await mainExec.exec(['log', '-n', '2', '--pretty=%s']);
    expect(logOut.trim().split('\n')).toEqual(['Özellik eklendi', 'init main']);
    const { stdout: statusOut } = await mainExec.exec(['status', '--porcelain']);
    expect(statusOut.trim()).toBe('');
    expect(repoDir).toBeTruthy();
  });

  it('refuses merge when target checkout has uncommitted changes', async () => {
    const { repoDir, wtDir, mainExec, wtExec, repoGitExec } = await setupRepoWithWorktree();
    await writeFile(path.join(wtDir, 'feature.txt'), 'change\n', 'utf8');
    await wtExec.exec(['add', 'feature.txt']);
    await wtExec.exec(['commit', '-m', 'feat change']);

    await writeFile(path.join(repoDir, 'dirty.txt'), 'uncommitted\n', 'utf8');

    const result = await mergeLocalBranch(repoGitExec, {
      sourceBranch: 'feat/demo',
      targetBranch: 'main',
      strategy: 'merge',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('dirty-target');
    }
    const { stdout: headMsg } = await mainExec.exec(['log', '-1', '--pretty=%s']);
    expect(headMsg.trim()).toBe('init main');
  });

  it('aborts cleanly on merge conflicts and returns conflicted files', async () => {
    const { repoDir, wtDir, mainExec, wtExec, repoGitExec } = await setupRepoWithWorktree();
    await writeFile(path.join(repoDir, 'base.txt'), 'from main\n', 'utf8');
    await mainExec.exec(['add', 'base.txt']);
    await mainExec.exec(['commit', '-m', 'main conflict edit']);

    await writeFile(path.join(wtDir, 'base.txt'), 'from feat\n', 'utf8');
    await wtExec.exec(['add', 'base.txt']);
    await wtExec.exec(['commit', '-m', 'feat conflict edit']);

    const result = await mergeLocalBranch(repoGitExec, {
      sourceBranch: 'feat/demo',
      targetBranch: 'main',
      strategy: 'merge',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        kind: 'merge-conflict',
        files: ['base.txt'],
      });
    }
    const { stdout: statusOut } = await mainExec.exec(['status', '--porcelain']);
    expect(statusOut.trim()).toBe('');
  });
});
