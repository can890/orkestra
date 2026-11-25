import {
  toRangeString,
  type MergeBaseRange,
  type GitDiffHunk,
  type GitHunkAction,
  type GitHunkScope,
} from '#runtimes/git/api';
import { ExecError, type BoundExec } from '#services/exec/api';

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseFileDiffHunks(diffText: string): GitDiffHunk[] {
  if (!diffText.trim()) return [];

  const normalized = diffText.replace(/\r\n/g, '\n');
  const rawLines = normalized.endsWith('\n')
    ? normalized.slice(0, -1).split('\n')
    : normalized.split('\n');

  const headerLines: string[] = [];
  const hunks: GitDiffHunk[] = [];

  let currentHunkHeader: string | null = null;
  let currentMeta: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
  } | null = null;
  let currentLines: string[] = [];

  const flushHunk = () => {
    if (!currentHunkHeader || !currentMeta || headerLines.length === 0) return;
    const index = hunks.length;
    const patch = [...headerLines, currentHunkHeader, ...currentLines].join('\n') + '\n';
    hunks.push({
      id: `hunk:${index}:${currentMeta.oldStart}:${currentMeta.newStart}`,
      header: currentHunkHeader,
      oldStart: currentMeta.oldStart,
      oldLines: currentMeta.oldLines,
      newStart: currentMeta.newStart,
      newLines: currentMeta.newLines,
      lines: currentLines,
      patch,
    });
  };

  for (const line of rawLines) {
    if (
      line.startsWith('GIT binary patch') ||
      (line.startsWith('Binary files ') && line.endsWith(' differ'))
    ) {
      return [];
    }

    const match = HUNK_HEADER_RE.exec(line);
    if (match) {
      flushHunk();
      currentHunkHeader = line;
      currentMeta = {
        oldStart: Number.parseInt(match[1]!, 10),
        oldLines: match[2] !== undefined ? Number.parseInt(match[2], 10) : 1,
        newStart: Number.parseInt(match[3]!, 10),
        newLines: match[4] !== undefined ? Number.parseInt(match[4], 10) : 1,
      };
      currentLines = [];
      continue;
    }

    if (currentHunkHeader === null) {
      headerLines.push(line);
    } else {
      currentLines.push(line);
    }
  }

  flushHunk();
  return hunks;
}

export async function getFileHunks(
  exec: BoundExec,
  filePath: string,
  scope: GitHunkScope,
  range?: MergeBaseRange
): Promise<GitDiffHunk[]> {
  const args = [
    ...(range ? ['--literal-pathspecs'] : []),
    'diff',
    '--no-ext-diff',
    '--no-color',
    '-U3',
    ...(range ? ['--no-textconv', toRangeString(range)] : scope === 'staged' ? ['--cached'] : []),
    '--',
    filePath,
  ];
  const { stdout } = await exec.exec(args);
  return parseFileDiffHunks(stdout);
}

export async function applyFileHunk(
  exec: BoundExec,
  patch: string,
  action: GitHunkAction
): Promise<void> {
  const flags =
    action === 'stage'
      ? ['--cached', '--unidiff-zero']
      : action === 'unstage'
        ? ['--cached', '--reverse', '--unidiff-zero']
        : ['--reverse', '--unidiff-zero'];
  const args = ['apply', ...flags, '-'];

  const child = await exec.spawn(args);
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', (error: Error) => reject(error));
    child.on('close', (exitCode: number | null) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new ExecError(exec.file, args, exitCode, stdout, stderr));
      }
    });

    child.stdin.end(patch);
  });
}
