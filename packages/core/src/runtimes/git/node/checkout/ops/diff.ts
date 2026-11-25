import type { PortableRelativePath } from '#primitives/path/api';
import { toRangeString, toRefString, type DiffTarget, type GitChange } from '#runtimes/git/api';
import { checkoutFailures } from '#runtimes/git/node/checkout/errors';
import { type BoundExec } from '#services/exec/api';
import { parseNameStatus, parseNumstat, parseRawDiff } from './diff-parser';

export function resolveDiffTarget(base: DiffTarget): { cached: boolean; ref?: string } {
  if ('base' in base) return { cached: false, ref: toRangeString(base) };
  if (base.kind === 'staged') return { cached: true, ref: '--cached' };
  if (base.kind === 'unstaged') return { cached: false };
  if (base.kind === 'head') return { cached: false, ref: 'HEAD' };
  return { cached: false, ref: toRefString(base) };
}

export async function getChangedFiles(
  exec: BoundExec,
  base: DiffTarget,
  toPortablePath: (filePath: string) => PortableRelativePath
): Promise<GitChange[]> {
  const resolved = resolveDiffTarget(base);
  const targetArgs = resolved.cached ? ['--cached'] : resolved.ref ? [resolved.ref] : [];
  const diffArgs = ['diff', '--numstat', '-z', ...targetArgs];
  const names = 'base' in base ? ['--raw', '--no-abbrev'] : ['--name-status'];
  const nameArgs = ['diff', ...names, '-z', ...targetArgs];

  let numstatResult: Awaited<ReturnType<BoundExec['exec']>>;
  let nameStatusResult: Awaited<ReturnType<BoundExec['exec']>>;
  try {
    [numstatResult, nameStatusResult] = await Promise.all([
      exec.exec(diffArgs),
      exec.exec(nameArgs),
    ]);
  } catch (error) {
    if ('kind' in base && base.kind === 'head' && checkoutFailures.isUnbornHead(error)) return [];
    throw error;
  }
  const numstat = parseNumstat(numstatResult.stdout);
  const changes: GitChange[] = [];

  const entries =
    'base' in base
      ? parseRawDiff(nameStatusResult.stdout)
      : parseNameStatus(nameStatusResult.stdout);
  for (const [filePath, status, diffRevision] of entries) {
    const stat = numstat.get(filePath);
    changes.push({
      path: toPortablePath(filePath),
      status,
      ...(diffRevision !== undefined ? { diffRevision } : {}),
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
    });
  }

  return changes;
}
