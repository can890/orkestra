import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestWire, type TestWire } from '@orkestra/wire/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TempStoreHandle } from '#primitives/sqlite-store/api';
import { workspaceRegistryContract } from '#runtimes/workspace-registry/api';
import {
  workspaceRegistryStore,
  type WorkspaceRegistryDb,
} from '#runtimes/workspace-registry/node/persistence/store';
import { WorkspaceRegistryRuntime } from '#runtimes/workspace-registry/node/runtime';
import { LocalAttachmentStore } from '#services/attachments/node/local-attachment-store';
import { createWorkspaceRegistryController } from './api/controller';

// Depolama temizliği bir görev worktree'sini `git worktree remove` ile kaldırdığında
// kayıt defterinin davranışı: kayıt kalır ve "missing" gözlenir, dal ve commit'ler
// korunur; aynı kimlikle yeniden oluşturma (masaüstünün "Recreate worktree" akışı)
// worktree'yi aynı daldan geri getirir.

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}

describe('a task worktree removed by storage cleanup', () => {
  let root: string;
  let handle: TempStoreHandle<WorkspaceRegistryDb>;
  let runtime: WorkspaceRegistryRuntime;
  let wire: TestWire<typeof workspaceRegistryContract>;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-cleaned-')));
    handle = await workspaceRegistryStore.openTemp();
    runtime = new WorkspaceRegistryRuntime({
      attachments: new LocalAttachmentStore(path.join(root, 'attachments')),
      handle,
    });
    wire = createTestWire(workspaceRegistryContract, createWorkspaceRegistryController(runtime));
  });

  afterEach(async () => {
    wire.dispose();
    runtime.dispose();
    handle.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('is observed missing, keeps its branch and can be recreated', async () => {
    const repoPath = path.join(root, 'repo');
    await fs.mkdir(repoPath);
    git(repoPath, 'init', '--initial-branch=main');
    await fs.writeFile(path.join(repoPath, 'README.md'), '# repo\n');
    git(repoPath, 'add', '.');
    git(repoPath, 'commit', '-m', 'initial');
    expect(
      (await wire.client.createWorkspace({ workspaceId: 'repo', path: repoPath })).success
    ).toBe(true);

    const worktreePath = path.join(root, 'worktrees', 'task');
    const input = {
      workspaceId: 'wt-task',
      repositoryId: 'repo',
      branch: 'orkestra/task',
      baseRef: 'main',
      path: worktreePath,
      preservePatterns: [],
    };
    const created = await wire.client.createWorktree(input);
    expect(created.success).toBe(true);
    await fs.writeFile(path.join(worktreePath, 'work.txt'), 'agent work\n');
    git(worktreePath, 'add', '.');
    git(worktreePath, 'commit', '-m', 'agent work');
    const workCommit = git(worktreePath, 'rev-parse', 'HEAD');

    // Temizliğin yaptığı: zorlamasız `git worktree remove` (dal silinmez).
    git(repoPath, 'worktree', 'remove', '--', worktreePath);
    expect((await wire.client.refresh({ workspaceId: 'wt-task' })).success).toBe(true);

    const records = await wire.client.records.state(undefined, 'list').snapshot();
    expect(records.data['wt-task']?.observedStatus).toBe('missing');
    expect(git(repoPath, 'rev-parse', 'refs/heads/orkestra/task')).toBe(workCommit);

    // Tamamlanmış bir oluşturmanın düz tekrarı bir no-op'tur; worktree geri gelmez.
    // Bu yüzden masaüstü temizlenmiş worktree'yi kaydı silip yeniden kurarak geri getirir.
    const replay = await wire.client.createWorktree(input);
    expect(replay.success).toBe(true);
    await expect(fs.stat(worktreePath)).rejects.toThrow();

    // Yeniden oluşturma: kayıt kaldırılıp aynı kimlik ve dalla yeniden kurulur
    // (masaüstü "Recreate worktree" = removeAndReprovision akışı).
    expect(
      (await wire.client.deleteWorktree({ workspaceId: 'wt-task', deleteBranch: false })).success
    ).toBe(true);
    expect(git(repoPath, 'rev-parse', 'refs/heads/orkestra/task')).toBe(workCommit);
    const recreated = await wire.client.createWorktree(input);
    expect(recreated.success).toBe(true);
    if (recreated.success) expect(recreated.data.observedStatus).toBe('present');
    expect(await fs.readFile(path.join(worktreePath, 'work.txt'), 'utf8')).toBe('agent work\n');
    expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(workCommit);
  });
});
