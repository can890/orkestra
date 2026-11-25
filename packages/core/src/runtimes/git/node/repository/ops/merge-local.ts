import type { Result } from '@orkestra/shared';
import { ok } from '@orkestra/shared';
import {
  gitErr,
  shortName,
  type GitCommandError,
  type MergeLocalBranchResult,
} from '#runtimes/git/api';
import { toHostAbsolutePath, toNativeAbsolutePath } from '#runtimes/git/node/allocation/paths';
import { commandFailed, gitFailure } from '#runtimes/git/node/exec/errors';
import { parseWorktreeList } from '#runtimes/git/node/repository/ops/worktrees';
import { createBoundExec, type BoundExec } from '#services/exec/api';

export type MergeLocalBranchParams = {
  sourceBranch: string;
  targetBranch: string;
  strategy: 'merge' | 'squash';
  commitMessage?: string;
};

async function hasStagedDiff(exec: BoundExec): Promise<boolean> {
  try {
    await exec.exec(['diff', '--cached', '--quiet']);
    return false;
  } catch (error) {
    if (gitFailure(error).exitCode === 1) return true;
    throw error;
  }
}

export async function mergeLocalBranch(
  repoExec: BoundExec,
  params: MergeLocalBranchParams
): Promise<Result<MergeLocalBranchResult, GitCommandError>> {
  const sourceBranch = params.sourceBranch.trim();
  const targetBranch = params.targetBranch.trim();
  if (!sourceBranch || !targetBranch) {
    return gitErr.commandFailed('Kaynak ve hedef dal adları boş olamaz.');
  }
  if (sourceBranch === targetBranch) {
    return gitErr.commandFailed('Kaynak ve hedef dal aynı olamaz.');
  }

  try {
    const { stdout: wtOut } = await repoExec.exec(['worktree', 'list', '--porcelain']);
    const worktrees = parseWorktreeList(wtOut, toHostAbsolutePath);

    const exactTargetWt = worktrees.find(
      (wt) => wt.head.kind === 'branch' && shortName(wt.head.ref) === targetBranch
    );
    const mainWt = worktrees.find((wt) => wt.isMain);
    const chosenWt = exactTargetWt ?? mainWt;

    if (!chosenWt) {
      return gitErr.commandFailed(`'${targetBranch}' dalı için çalışma dizini bulunamadı.`);
    }

    if (
      !exactTargetWt &&
      chosenWt.head.kind === 'branch' &&
      shortName(chosenWt.head.ref) === sourceBranch
    ) {
      return ok({
        kind: 'dirty-target',
        message: `Ana çalışma dizini şu anda '${sourceBranch}' dalında olduğu için birleştirme yapılamıyor.`,
      });
    }

    const targetExec = createBoundExec({
      file: repoExec.file,
      cwd: toNativeAbsolutePath(chosenWt.worktreePath),
      env: repoExec.env,
    });

    const { stdout: statusOut } = await targetExec.exec(['status', '--porcelain']);
    if (statusOut.trim().length > 0) {
      return ok({
        kind: 'dirty-target',
        message:
          'Hedef çalışma dizininde kaydedilmemiş değişiklikler var; önce commit veya stash yapın.',
      });
    }

    if (!exactTargetWt) {
      await targetExec.exec(['checkout', targetBranch]);
    }

    const { stdout: aheadOut } = await targetExec.exec([
      'rev-list',
      '--count',
      `${targetBranch}..${sourceBranch}`,
    ]);
    const mergedCommits = Number.parseInt(aheadOut.trim(), 10) || 0;
    if (mergedCommits === 0) {
      return ok({ kind: 'already-up-to-date' });
    }

    const commitMessage =
      params.commitMessage?.trim() ||
      `${params.strategy === 'squash' ? 'squash' : 'merge'}: ${sourceBranch} -> ${targetBranch}`;

    try {
      if (params.strategy === 'merge') {
        await targetExec.exec(['merge', '--no-ff', '-m', commitMessage, '--', sourceBranch]);
      } else {
        await targetExec.exec(['merge', '--squash', '--', sourceBranch]);
        const hasChanges = await hasStagedDiff(targetExec);
        if (!hasChanges) {
          return ok({ kind: 'already-up-to-date' });
        }
        await targetExec.exec(['commit', '-m', commitMessage]);
      }
    } catch (mergeError) {
      const conflictsOut = await targetExec
        .exec(['diff', '--name-only', '--diff-filter=U'])
        .then((res) => res.stdout)
        .catch(() => '');
      const conflictFiles = conflictsOut
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      if (params.strategy === 'merge') {
        await targetExec.exec(['merge', '--abort']).catch(() => undefined);
      }
      await targetExec.exec(['reset', '--merge']).catch(() => undefined);

      const failure = gitFailure(mergeError);
      if (conflictFiles.length > 0 || /CONFLICT/i.test(failure.stdout + failure.stderr)) {
        return ok({
          kind: 'merge-conflict',
          files: conflictFiles,
          message:
            conflictFiles.length > 0
              ? `Birleştirme çakışması (${conflictFiles.length} dosya). Hedef dal temiz bırakıldı.`
              : 'Birleştirme çakışması oluştu. Hedef dal temiz bırakıldı.',
        });
      }
      throw mergeError;
    }

    const { stdout: headSha } = await targetExec.exec(['rev-parse', 'HEAD']);
    return ok({
      kind: 'merged',
      commitHash: headSha.trim(),
      mergedCommits,
    });
  } catch (error) {
    return commandFailed(error);
  }
}
