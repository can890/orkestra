import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBoundExec } from '#services/exec/api';
import { applyFileHunk, getFileHunks, parseFileDiffHunks } from './hunk-patch';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempGitCheckout() {
  const root = await mkdtemp(path.join(tmpdir(), 'orkestra-hunk-test-'));
  tempDirs.push(root);
  const exec = createBoundExec({ file: 'git', cwd: root, env: process.env });
  await exec.exec(['init', '-b', 'main']);
  await exec.exec(['config', 'user.email', 'test@orkestra.local']);
  await exec.exec(['config', 'user.name', 'Test User']);

  const filePath = path.join(root, 'sample.txt');
  const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`);
  await writeFile(filePath, lines.join('\n') + '\n', 'utf8');
  await exec.exec(['add', 'sample.txt']);
  await exec.exec(['commit', '-m', 'initial']);
  return { root, exec, filePath };
}

describe('parseFileDiffHunks', () => {
  it('splits multi-hunk unified diff into standalone patches', () => {
    const sample = [
      'diff --git a/foo.ts b/foo.ts',
      'index 1111111..2222222 100644',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '+addedTop',
      ' line2',
      ' line3',
      '@@ -10,3 +11,3 @@',
      ' line10',
      '-oldBottom',
      '+newBottom',
      ' line12',
    ].join('\n');

    const hunks = parseFileDiffHunks(sample);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({
      id: 'hunk:0:1:1',
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
    });
    expect(hunks[0]!.patch).toContain('+addedTop');
    expect(hunks[0]!.patch).not.toContain('newBottom');
    expect(hunks[1]).toMatchObject({
      id: 'hunk:1:10:11',
      oldStart: 10,
      newStart: 11,
    });
    expect(hunks[1]!.patch).toContain('-oldBottom');
    expect(hunks[1]!.patch).not.toContain('addedTop');
  });

  it('returns empty array for binary diffs', () => {
    expect(parseFileDiffHunks('Binary files a/icon.png and b/icon.png differ\n')).toEqual([]);
  });
});

describe('getFileHunks & applyFileHunk', () => {
  it('reads the PR commit range independently of working-tree changes', async () => {
    const { exec, filePath } = await makeTempGitCheckout();
    const base = (await exec.exec(['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(filePath, 'committed PR content\n', 'utf8');
    await exec.exec(['add', 'sample.txt']);
    await exec.exec(['commit', '-m', 'PR change']);
    const head = (await exec.exec(['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(filePath, 'working copy only\n', 'utf8');

    const hunks = await getFileHunks(exec, 'sample.txt', 'unstaged', {
      base: { kind: 'commit', sha: base },
      head: { kind: 'commit', sha: head },
    });
    expect(hunks[0]?.lines).toContain('+committed PR content');
    expect(hunks[0]?.lines).not.toContain('+working copy only');
  });

  it('stages, unstages, and discards individual hunks cleanly', async () => {
    const { exec, filePath } = await makeTempGitCheckout();
    const modified = Array.from({ length: 20 }, (_, i) => {
      if (i === 1) return 'line-2-edited';
      if (i === 17) return 'line-18-edited';
      return `line-${i + 1}`;
    });
    await writeFile(filePath, modified.join('\n') + '\n', 'utf8');

    const unstaged = await getFileHunks(exec, 'sample.txt', 'unstaged');
    expect(unstaged).toHaveLength(2);

    // Stage only the first hunk.
    await applyFileHunk(exec, unstaged[0]!.patch, 'stage');
    const stagedAfterFirst = await getFileHunks(exec, 'sample.txt', 'staged');
    const unstagedAfterFirst = await getFileHunks(exec, 'sample.txt', 'unstaged');
    expect(stagedAfterFirst).toHaveLength(1);
    expect(stagedAfterFirst[0]!.patch).toContain('line-2-edited');
    expect(unstagedAfterFirst).toHaveLength(1);
    expect(unstagedAfterFirst[0]!.patch).toContain('line-18-edited');

    // Discard the remaining unstaged hunk, leaving only the staged hunk.
    await applyFileHunk(exec, unstagedAfterFirst[0]!.patch, 'discard');
    const unstagedAfterDiscard = await getFileHunks(exec, 'sample.txt', 'unstaged');
    expect(unstagedAfterDiscard).toEqual([]);

    // Unstage the first hunk cleanly.
    await applyFileHunk(exec, stagedAfterFirst[0]!.patch, 'unstage');
    const stagedFinal = await getFileHunks(exec, 'sample.txt', 'staged');
    const unstagedFinal = await getFileHunks(exec, 'sample.txt', 'unstaged');
    expect(stagedFinal).toEqual([]);
    expect(unstagedFinal).toHaveLength(1);
    expect(unstagedFinal[0]!.patch).toContain('line-2-edited');
  });
});
