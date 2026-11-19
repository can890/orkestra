import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_CHECKPOINTS_PER_CONVERSATION } from '#runtimes/git/api';
import { createBoundExec } from '#services/exec/api';
import {
  createCheckpoint,
  deleteCheckpoints,
  listCheckpoints,
  previewCheckpointRestore,
  restoreCheckpoint,
  type CheckpointCheckout,
} from './checkpoint';

const execFileAsync = promisify(execFile);
const CONVERSATION = 'conv-1';
const PROMPT_ID = '11111111-1111-4111-8111-111111111111';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function makeRepo() {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), 'orkestra-checkpoint-test-')));
  cleanups.push(() => rm(repo, { recursive: true, force: true }));
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test User');
  await writeFile(path.join(repo, '.gitignore'), 'ignored.log\nbuild/\n', 'utf8');
  await writeFile(path.join(repo, 'tracked.txt'), 'v1\n', 'utf8');
  await writeFile(path.join(repo, 'staged.txt'), 'staged v1\n', 'utf8');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'init');
  const gitDir = path.join(repo, '.git');
  const checkout: CheckpointCheckout = {
    exec: createBoundExec({ file: 'git', cwd: repo }),
    checkoutRoot: repo,
    gitDir,
  };
  return { repo, gitDir, checkout };
}

/** Everything restore promises to leave alone: HEAD, branch, refs, and the real index bytes. */
async function protectedState(repo: string, gitDir: string) {
  return {
    head: (await git(repo, 'rev-parse', 'HEAD')).trim(),
    branch: (await git(repo, 'symbolic-ref', 'HEAD')).trim(),
    branches: await git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
    index: (await readFile(path.join(gitDir, 'index'))).toString('base64'),
  };
}

async function exists(filePath: string): Promise<boolean> {
  return lstat(filePath).then(
    () => true,
    () => false
  );
}

describe('checkpoints', () => {
  it('snapshots tracked, staged, and untracked files without touching HEAD, branch, or index', async () => {
    const { repo, gitDir, checkout } = await makeRepo();
    await writeFile(path.join(repo, 'tracked.txt'), 'edited\n', 'utf8');
    await writeFile(path.join(repo, 'staged.txt'), 'staged v2\n', 'utf8');
    await git(repo, 'add', 'staged.txt');
    await writeFile(path.join(repo, 'staged.txt'), 'staged v3\n', 'utf8');
    await writeFile(path.join(repo, 'untracked.txt'), 'new\n', 'utf8');
    await writeFile(path.join(repo, 'ignored.log'), 'noise\n', 'utf8');
    await mkdir(path.join(repo, 'build'));
    await writeFile(path.join(repo, 'build', 'out.js'), 'x\n', 'utf8');
    // `git status` may refresh the real index, so run it before capturing the protected state.
    const statusBefore = await git(repo, 'status', '--porcelain=v1');
    const before = await protectedState(repo, gitDir);

    const checkpoint = await createCheckpoint(checkout, {
      conversationId: CONVERSATION,
      promptId: PROMPT_ID,
    });

    expect(checkpoint).toMatchObject({ seq: 1, kind: 'prompt', promptId: PROMPT_ID });
    expect(await protectedState(repo, gitDir)).toEqual(before);
    expect(await git(repo, 'status', '--porcelain=v1')).toBe(statusBefore);
    const files = (await git(repo, 'ls-tree', '-r', '--name-only', checkpoint.hash)).split('\n');
    expect(files).toEqual(
      expect.arrayContaining(['tracked.txt', 'staged.txt', 'untracked.txt', '.gitignore'])
    );
    expect(files).not.toContain('ignored.log');
    expect(files).not.toContain('build/out.js');
    expect(await git(repo, 'show', `${checkpoint.hash}:staged.txt`)).toBe('staged v3\n');
    expect(await git(repo, 'show', `${checkpoint.hash}:tracked.txt`)).toBe('edited\n');
    expect(await git(repo, 'rev-parse', `${checkpoint.hash}^`)).toBe(`${before.head}\n`);
    // No leaked temporary index directories inside the repository.
    expect((await readdir(gitDir)).filter((name) => name.startsWith('orkestra-'))).toEqual([]);
  });

  it('numbers checkpoints per conversation and lists them oldest first', async () => {
    const { checkout } = await makeRepo();
    await createCheckpoint(checkout, { conversationId: CONVERSATION });
    await createCheckpoint(checkout, { conversationId: 'conv-2' });
    await createCheckpoint(checkout, {
      conversationId: CONVERSATION,
      kind: 'safety',
      label: 'a\nb',
    });

    const first = await listCheckpoints(checkout, CONVERSATION);
    expect(first.map((checkpoint) => [checkpoint.seq, checkpoint.kind])).toEqual([
      [1, 'prompt'],
      [2, 'safety'],
    ]);
    expect(first[1]?.label).toBe('a b');
    expect((await listCheckpoints(checkout, 'conv-2')).map((c) => c.seq)).toEqual([1]);
  });

  it('rejects conversation ids that are not ref-safe', async () => {
    const { checkout } = await makeRepo();
    await expect(createCheckpoint(checkout, { conversationId: '../evil' })).rejects.toThrow();
    await expect(listCheckpoints(checkout, 'a b')).rejects.toThrow();
  });

  it('snapshots a repository without commits', async () => {
    const repo = await realpath(await mkdtemp(path.join(tmpdir(), 'orkestra-checkpoint-test-')));
    cleanups.push(() => rm(repo, { recursive: true, force: true }));
    await git(repo, 'init', '-b', 'main');
    await writeFile(path.join(repo, 'a.txt'), 'a\n', 'utf8');
    const checkout: CheckpointCheckout = {
      exec: createBoundExec({ file: 'git', cwd: repo }),
      checkoutRoot: repo,
      gitDir: path.join(repo, '.git'),
    };

    const checkpoint = await createCheckpoint(checkout, { conversationId: CONVERSATION });

    expect(await git(repo, 'ls-tree', '--name-only', checkpoint.hash)).toBe('a.txt\n');
    await expect(git(repo, 'rev-parse', 'HEAD')).rejects.toThrow();
  });

  it('restores edits, deletions, and untracked files while keeping ignored files', async () => {
    const { repo, gitDir, checkout } = await makeRepo();
    await writeFile(path.join(repo, 'tracked.txt'), 'before\n', 'utf8');
    await writeFile(path.join(repo, 'untracked.txt'), 'keep me\n', 'utf8');
    await mkdir(path.join(repo, 'dir'));
    await writeFile(path.join(repo, 'dir', 'nested.txt'), 'nested\n', 'utf8');
    await git(repo, 'add', 'staged.txt');
    const checkpoint = await createCheckpoint(checkout, { conversationId: CONVERSATION });

    // The agent edits, deletes, and creates files, and a tool writes an ignored file.
    await writeFile(path.join(repo, 'tracked.txt'), 'agent edit\n', 'utf8');
    await rm(path.join(repo, 'untracked.txt'));
    await rm(path.join(repo, 'dir'), { recursive: true });
    await mkdir(path.join(repo, 'agent', 'deep'), { recursive: true });
    await writeFile(path.join(repo, 'agent', 'deep', 'new.txt'), 'new\n', 'utf8');
    await writeFile(path.join(repo, 'agent-new.txt'), 'new\n', 'utf8');
    await writeFile(path.join(repo, 'ignored.log'), 'precious\n', 'utf8');
    await git(repo, 'add', 'agent-new.txt');
    const before = await protectedState(repo, gitDir);

    const preview = await previewCheckpointRestore(checkout, CONVERSATION, checkpoint.seq);
    expect(preview.files.slice().sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'agent-new.txt', change: 'delete' },
      { path: 'agent/deep/new.txt', change: 'delete' },
      { path: 'dir/nested.txt', change: 'recreate' },
      { path: 'tracked.txt', change: 'overwrite' },
      { path: 'untracked.txt', change: 'recreate' },
    ]);
    expect(preview).toMatchObject({ recreate: 2, overwrite: 1, delete: 2, truncated: false });
    // Previewing changes nothing.
    expect(await readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('agent edit\n');
    expect(await protectedState(repo, gitDir)).toEqual(before);

    const result = await restoreCheckpoint(checkout, CONVERSATION, checkpoint.seq);

    expect(result).toMatchObject({ recreate: 2, overwrite: 1, delete: 2, safetySeq: 2 });
    expect(await readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('before\n');
    expect(await readFile(path.join(repo, 'untracked.txt'), 'utf8')).toBe('keep me\n');
    expect(await readFile(path.join(repo, 'dir', 'nested.txt'), 'utf8')).toBe('nested\n');
    expect(await exists(path.join(repo, 'agent-new.txt'))).toBe(false);
    // The directory chain emptied by the deletions is removed too.
    expect(await exists(path.join(repo, 'agent'))).toBe(false);
    expect(await readFile(path.join(repo, 'ignored.log'), 'utf8')).toBe('precious\n');
    expect(await protectedState(repo, gitDir)).toEqual(before);
  });

  it('never deletes ignored files that sit where a restored path has to go', async () => {
    const { repo, checkout } = await makeRepo();
    await writeFile(path.join(repo, 'thing'), 'a file\n', 'utf8');
    await mkdir(path.join(repo, 'cache'));
    await writeFile(path.join(repo, 'cache', 'a.txt'), 'cached\n', 'utf8');
    await writeFile(path.join(repo, 'plain.txt'), 'plain v1\n', 'utf8');
    const checkpoint = await createCheckpoint(checkout, { conversationId: CONVERSATION });

    // `thing` becomes a directory that only holds an ignored file.
    await rm(path.join(repo, 'thing'));
    await mkdir(path.join(repo, 'thing'));
    await writeFile(path.join(repo, 'thing', 'ignored.log'), 'precious dir content\n', 'utf8');
    // `cache/` becomes an ignored regular file.
    await rm(path.join(repo, 'cache'), { recursive: true });
    await writeFile(path.join(repo, '.gitignore'), 'ignored.log\nbuild/\ncache\n', 'utf8');
    await writeFile(path.join(repo, 'cache'), 'precious file content\n', 'utf8');
    await writeFile(path.join(repo, 'plain.txt'), 'plain v2\n', 'utf8');

    const result = await restoreCheckpoint(checkout, CONVERSATION, checkpoint.seq);

    // Ignored content is not in any checkpoint, so it must survive the restore.
    expect(await readFile(path.join(repo, 'thing', 'ignored.log'), 'utf8')).toBe(
      'precious dir content\n'
    );
    expect(await readFile(path.join(repo, 'cache'), 'utf8')).toBe('precious file content\n');
    // Everything that is not blocked is still restored, and the blocked paths are reported.
    expect(await readFile(path.join(repo, 'plain.txt'), 'utf8')).toBe('plain v1\n');
    expect(result.skipped.slice().sort()).toEqual(['cache/a.txt', 'thing']);
  });

  it('can undo a restore through the safety checkpoint', async () => {
    const { repo, gitDir, checkout } = await makeRepo();
    const checkpoint = await createCheckpoint(checkout, { conversationId: CONVERSATION });
    await writeFile(path.join(repo, 'tracked.txt'), 'later work\n', 'utf8');
    await writeFile(path.join(repo, 'later.txt'), 'later\n', 'utf8');
    const before = await protectedState(repo, gitDir);

    const restored = await restoreCheckpoint(checkout, CONVERSATION, checkpoint.seq);
    expect(await readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('v1\n');
    expect(await exists(path.join(repo, 'later.txt'))).toBe(false);
    const safety = (await listCheckpoints(checkout, CONVERSATION)).find(
      (candidate) => candidate.seq === restored.safetySeq
    );
    expect(safety).toMatchObject({ kind: 'safety' });

    await restoreCheckpoint(checkout, CONVERSATION, restored.safetySeq);

    expect(await readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('later work\n');
    expect(await readFile(path.join(repo, 'later.txt'), 'utf8')).toBe('later\n');
    expect(await protectedState(repo, gitDir)).toEqual(before);
  });

  it('restores through a file-to-directory change and executable bits', async () => {
    const { repo, checkout } = await makeRepo();
    await writeFile(path.join(repo, 'swap'), 'i am a file\n', 'utf8');
    await writeFile(path.join(repo, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    const checkpoint = await createCheckpoint(checkout, { conversationId: CONVERSATION });
    await rm(path.join(repo, 'swap'));
    await mkdir(path.join(repo, 'swap'));
    await writeFile(path.join(repo, 'swap', 'inner.txt'), 'inner\n', 'utf8');
    await writeFile(path.join(repo, 'run.sh'), '#!/bin/sh\n', { mode: 0o644 });

    await restoreCheckpoint(checkout, CONVERSATION, checkpoint.seq);

    expect(await readFile(path.join(repo, 'swap'), 'utf8')).toBe('i am a file\n');
    expect((await lstat(path.join(repo, 'run.sh'))).mode & 0o111).not.toBe(0);
  });

  it('replaces a symlinked directory without writing through it', async () => {
    const { repo, checkout } = await makeRepo();
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'orkestra-outside-')));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(path.join(outside, 'victim.txt'), 'do not delete\n', 'utf8');
    await mkdir(path.join(repo, 'pkg'));
    await writeFile(path.join(repo, 'pkg', 'victim.txt'), 'inside\n', 'utf8');
    const snapshot = await createCheckpoint(checkout, { conversationId: 'conv-link' });
    await rm(path.join(repo, 'pkg'), { recursive: true });
    await symlink(outside, path.join(repo, 'pkg'));

    // The current snapshot sees `pkg` as a symlink, so restoring replaces the link itself.
    await restoreCheckpoint(checkout, 'conv-link', snapshot.seq);

    expect(await readFile(path.join(outside, 'victim.txt'), 'utf8')).toBe('do not delete\n');
    expect(await readFile(path.join(repo, 'pkg', 'victim.txt'), 'utf8')).toBe('inside\n');
  });

  it('fails without changing anything when the checkpoint does not exist', async () => {
    const { repo, gitDir, checkout } = await makeRepo();
    await writeFile(path.join(repo, 'tracked.txt'), 'work\n', 'utf8');
    const before = await protectedState(repo, gitDir);

    await expect(restoreCheckpoint(checkout, CONVERSATION, 7)).rejects.toThrow(/not found/);

    expect(await readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('work\n');
    expect(await listCheckpoints(checkout, CONVERSATION)).toEqual([]);
    expect(await protectedState(repo, gitDir)).toEqual(before);
  });

  it('keeps at most 50 checkpoints per conversation, dropping the oldest', async () => {
    const { checkout } = await makeRepo();
    for (let index = 0; index < MAX_CHECKPOINTS_PER_CONVERSATION + 3; index += 1) {
      await createCheckpoint(checkout, { conversationId: CONVERSATION });
    }

    const seqs = (await listCheckpoints(checkout, CONVERSATION)).map(
      (checkpoint) => checkpoint.seq
    );

    expect(seqs).toHaveLength(MAX_CHECKPOINTS_PER_CONVERSATION);
    expect(seqs[0]).toBe(4);
    expect(seqs.at(-1)).toBe(MAX_CHECKPOINTS_PER_CONVERSATION + 3);
  }, 120_000);

  it('does not prune the restore target when the safety checkpoint overflows the cap', async () => {
    const { repo, checkout } = await makeRepo();
    for (let index = 0; index < MAX_CHECKPOINTS_PER_CONVERSATION; index += 1) {
      await createCheckpoint(checkout, { conversationId: CONVERSATION });
    }
    await writeFile(path.join(repo, 'tracked.txt'), 'changed\n', 'utf8');

    await restoreCheckpoint(checkout, CONVERSATION, 1);

    const seqs = (await listCheckpoints(checkout, CONVERSATION)).map(
      (checkpoint) => checkpoint.seq
    );
    expect(seqs).toContain(1);
    expect(seqs).toHaveLength(MAX_CHECKPOINTS_PER_CONVERSATION);
    expect(await readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('v1\n');
  }, 120_000);

  it('deletes only the given conversation refs', async () => {
    const { repo, checkout } = await makeRepo();
    await createCheckpoint(checkout, { conversationId: CONVERSATION });
    await createCheckpoint(checkout, { conversationId: CONVERSATION });
    await createCheckpoint(checkout, { conversationId: 'conv-2' });

    await expect(deleteCheckpoints(checkout, CONVERSATION)).resolves.toBe(2);

    expect(await listCheckpoints(checkout, CONVERSATION)).toEqual([]);
    expect(await listCheckpoints(checkout, 'conv-2')).toHaveLength(1);
    expect(await git(repo, 'for-each-ref', 'refs/orkestra/checkpoints/conv-1/')).toBe('');
    await expect(deleteCheckpoints(checkout, CONVERSATION)).resolves.toBe(0);
  });

  it('works in a linked worktree and leaves the main checkout alone', async () => {
    const { repo } = await makeRepo();
    const worktree = path.join(await realpath(tmpdir()), `orkestra-ckpt-wt-${Date.now()}`);
    cleanups.push(async () => {
      await git(repo, 'worktree', 'remove', '--force', worktree).catch(() => undefined);
      await rm(worktree, { recursive: true, force: true });
    });
    await git(repo, 'worktree', 'add', '-b', 'task', worktree);
    const gitDir = (await git(worktree, 'rev-parse', '--absolute-git-dir')).trim();
    const checkout: CheckpointCheckout = {
      exec: createBoundExec({ file: 'git', cwd: worktree }),
      checkoutRoot: worktree,
      gitDir,
    };
    await writeFile(path.join(worktree, 'wt.txt'), 'one\n', 'utf8');
    const checkpoint = await createCheckpoint(checkout, { conversationId: CONVERSATION });
    await writeFile(path.join(worktree, 'wt.txt'), 'two\n', 'utf8');
    await writeFile(path.join(repo, 'tracked.txt'), 'main edit\n', 'utf8');
    const headBefore = (await git(worktree, 'rev-parse', 'HEAD')).trim();

    await restoreCheckpoint(checkout, CONVERSATION, checkpoint.seq);

    expect(await readFile(path.join(worktree, 'wt.txt'), 'utf8')).toBe('one\n');
    expect(await readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('main edit\n');
    expect((await git(worktree, 'rev-parse', 'HEAD')).trim()).toBe(headBefore);
    expect((await git(worktree, 'symbolic-ref', 'HEAD')).trim()).toBe('refs/heads/task');
  });
});
