import { copyFile, lstat, mkdtemp, realpath, rm, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePortableRelativePath, type PortableRelativePath } from '#primitives/path/api';
import {
  MAX_CHECKPOINTS_PER_CONVERSATION,
  checkpointConversationIdSchema,
  type Checkpoint,
  type CheckpointChange,
  type CheckpointKind,
  type CheckpointRestorePreview,
  type RestoreCheckpointResult,
} from '#runtimes/git/api';
import { CheckpointError, InvalidCheckoutPathError } from '#runtimes/git/node/checkout/errors';
import type { BoundExec } from '#services/exec/api';

/**
 * Conversation checkpoints: snapshots of a checkout's working files (untracked files included,
 * ignored files excluded) stored as commits under `refs/orkestra/checkpoints/<conversationId>/<seq>`.
 *
 * Snapshots and restores never touch the real index, HEAD, or the current branch: every git
 * command that reads or writes an index runs against a private temporary `GIT_INDEX_FILE`.
 */

const CHECKPOINT_REF_ROOT = 'refs/orkestra/checkpoints';
const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';
const SNAPSHOT_TIMEOUT_MS = 120_000;
const CHECKOUT_INDEX_CHUNK = 100;
const PREVIEW_FILE_LIMIT = 500;
const REF_CREATE_ATTEMPTS = 5;
const TRAILER_PREFIX = 'Orkestra-';
const COMMIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'Orkestra',
  GIT_AUTHOR_EMAIL: 'checkpoints@orkestra.invalid',
  GIT_COMMITTER_NAME: 'Orkestra',
  GIT_COMMITTER_EMAIL: 'checkpoints@orkestra.invalid',
} as const;

export type CheckpointCheckout = {
  readonly exec: BoundExec;
  readonly checkoutRoot: string;
  /** Private git directory of this checkout (holds the real index). */
  readonly gitDir: string;
};

export type CreateCheckpointOptions = {
  conversationId: string;
  promptId?: string;
  kind?: CheckpointKind;
  label?: string;
  /** Sequence that pruning must not delete (the restore target). */
  protectSeq?: number;
};

function conversationRefPrefix(conversationId: string): string {
  return `${CHECKPOINT_REF_ROOT}/${checkpointConversationIdSchema.parse(conversationId)}`;
}

function refFor(conversationId: string, seq: number): string {
  return `${conversationRefPrefix(conversationId)}/${seq}`;
}

async function withTempIndex<T>(
  checkout: CheckpointCheckout,
  seedFromRealIndex: boolean,
  run: (env: NodeJS.ProcessEnv) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'orkestra-checkpoint-'));
  const indexFile = path.join(dir, 'index');
  try {
    if (seedFromRealIndex) {
      // Seeding keeps tracked-but-ignored and staged-new files in the snapshot. A missing index
      // (fresh repository) simply starts empty.
      await copyFile(path.join(checkout.gitDir, 'index'), indexFile).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
    return await run({ GIT_INDEX_FILE: indexFile });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Writes the working files (tracked, staged, untracked, minus ignored) as a tree object. */
async function snapshotTree(checkout: CheckpointCheckout): Promise<string> {
  return withTempIndex(checkout, true, async (env) => {
    await checkout.exec.exec(['add', '-A'], { env, timeoutMs: SNAPSHOT_TIMEOUT_MS });
    const { stdout } = await checkout.exec.exec(['write-tree'], { env });
    return stdout.trim();
  });
}

async function resolveHeadCommit(exec: BoundExec): Promise<string | null> {
  try {
    const { stdout } = await exec.exec(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function checkpointMessage(conversationId: string, options: CreateCheckpointOptions): string {
  const kind = options.kind ?? 'prompt';
  const lines = [
    `orkestra checkpoint (${kind})`,
    '',
    `${TRAILER_PREFIX}Kind: ${kind}`,
    `${TRAILER_PREFIX}Conversation: ${conversationId}`,
  ];
  if (options.promptId) lines.push(`${TRAILER_PREFIX}Prompt: ${oneLine(options.promptId)}`);
  if (options.label) lines.push(`${TRAILER_PREFIX}Label: ${oneLine(options.label)}`);
  return lines.join('\n');
}

function parseCheckpointRecord(record: string): Checkpoint | null {
  const [refName, hash, createdAtSeconds, contents] = record.split(FIELD_SEP);
  if (!refName || !hash) return null;
  const seq = Number.parseInt(refName.slice(refName.lastIndexOf('/') + 1), 10);
  if (!Number.isInteger(seq) || seq <= 0) return null;
  const trailers = new Map<string, string>();
  for (const line of (contents ?? '').split('\n')) {
    if (!line.startsWith(TRAILER_PREFIX)) continue;
    const separator = line.indexOf(': ');
    if (separator < 0) continue;
    trailers.set(line.slice(TRAILER_PREFIX.length, separator), line.slice(separator + 2).trim());
  }
  const promptId = trailers.get('Prompt');
  const label = trailers.get('Label');
  return {
    seq,
    hash,
    createdAt: (Number.parseInt(createdAtSeconds ?? '', 10) || 0) * 1000,
    kind: trailers.get('Kind') === 'safety' ? 'safety' : 'prompt',
    ...(promptId ? { promptId } : {}),
    ...(label ? { label } : {}),
  };
}

export async function listCheckpoints(
  checkout: CheckpointCheckout,
  conversationId: string
): Promise<Checkpoint[]> {
  const prefix = conversationRefPrefix(conversationId);
  const { stdout } = await checkout.exec.exec([
    'for-each-ref',
    `--format=%(refname)${FIELD_SEP}%(objectname)${FIELD_SEP}%(creatordate:unix)${FIELD_SEP}%(contents)${RECORD_SEP}`,
    `${prefix}/`,
  ]);
  return stdout
    .split(RECORD_SEP)
    .map((record) => parseCheckpointRecord(record.replace(/^\n/, '')))
    .filter((checkpoint): checkpoint is Checkpoint => checkpoint !== null)
    .sort((left, right) => left.seq - right.seq);
}

async function requireCheckpoint(
  checkout: CheckpointCheckout,
  conversationId: string,
  seq: number
): Promise<Checkpoint> {
  const checkpoint = (await listCheckpoints(checkout, conversationId)).find(
    (candidate) => candidate.seq === seq
  );
  if (!checkpoint) throw new CheckpointError(`Checkpoint ${seq} was not found`);
  return checkpoint;
}

async function deleteRef(exec: BoundExec, ref: string): Promise<void> {
  await exec.exec(['update-ref', '-d', ref]);
}

export async function createCheckpoint(
  checkout: CheckpointCheckout,
  options: CreateCheckpointOptions
): Promise<Checkpoint> {
  const { exec } = checkout;
  const { conversationId } = options;
  conversationRefPrefix(conversationId);
  const tree = await snapshotTree(checkout);
  const head = await resolveHeadCommit(exec);
  const { stdout } = await exec.exec(
    [
      '-c',
      'commit.gpgsign=false',
      'commit-tree',
      tree,
      ...(head ? ['-p', head] : []),
      '-m',
      checkpointMessage(conversationId, options),
    ],
    { env: COMMIT_IDENTITY_ENV }
  );
  const hash = stdout.trim();

  let existing: Checkpoint[] = [];
  let seq = 0;
  for (let attempt = 1; ; attempt += 1) {
    existing = await listCheckpoints(checkout, conversationId);
    seq = (existing.at(-1)?.seq ?? 0) + 1;
    try {
      // The empty old value makes the update fail if another writer took this sequence.
      await exec.exec(['update-ref', refFor(conversationId, seq), hash, '']);
      break;
    } catch (error) {
      if (attempt >= REF_CREATE_ATTEMPTS) throw error;
    }
  }

  const overflow = existing.length + 1 - MAX_CHECKPOINTS_PER_CONVERSATION;
  if (overflow > 0) {
    const prunable = existing.filter((checkpoint) => checkpoint.seq !== options.protectSeq);
    for (const checkpoint of prunable.slice(0, overflow)) {
      await deleteRef(exec, refFor(conversationId, checkpoint.seq));
    }
  }

  const created = await listCheckpoints(checkout, conversationId);
  const checkpoint = created.find((candidate) => candidate.seq === seq);
  if (!checkpoint) throw new CheckpointError('Checkpoint was created but could not be read back');
  return checkpoint;
}

type TreeChange = { status: 'A' | 'D' | 'M'; path: PortableRelativePath };

/** Changes that turn `fromTree` into `toTree`; `A` means the path exists only in `toTree`. */
async function diffTrees(exec: BoundExec, fromTree: string, toTree: string): Promise<TreeChange[]> {
  const { stdout } = await exec.exec([
    'diff-tree',
    '-r',
    '-z',
    '--no-renames',
    '--name-status',
    fromTree,
    toTree,
  ]);
  const tokens = stdout.split('\0');
  const changes: TreeChange[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const status = tokens[index]?.[0];
    const filePath = tokens[index + 1];
    if (!filePath || (status !== 'A' && status !== 'D' && status !== 'M' && status !== 'T')) {
      continue;
    }
    changes.push({
      status: status === 'T' ? 'M' : status,
      path: toSafeRelativePath(filePath),
    });
  }
  return changes;
}

function toSafeRelativePath(filePath: string): PortableRelativePath {
  const parsed = parsePortableRelativePath(filePath, { unicodeNormalization: 'preserve' });
  if (!parsed.success || !parsed.data) throw new InvalidCheckoutPathError(filePath);
  const segments = parsed.data.split('/');
  if (
    segments.some(
      (segment) =>
        segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git'
    )
  ) {
    throw new InvalidCheckoutPathError(filePath);
  }
  return parsed.data;
}

function changeKind(change: TreeChange): CheckpointChange['change'] {
  if (change.status === 'A') return 'recreate';
  if (change.status === 'D') return 'delete';
  return 'overwrite';
}

function countByKind(changes: readonly TreeChange[]) {
  const counts = { recreate: 0, overwrite: 0, delete: 0 };
  for (const change of changes) counts[changeKind(change)] += 1;
  return counts;
}

async function treeOf(exec: BoundExec, commit: string): Promise<string> {
  const { stdout } = await exec.exec(['rev-parse', '--verify', `${commit}^{tree}`]);
  return stdout.trim();
}

/** What restoring `seq` would change right now; read-only for the checkout. */
export async function previewCheckpointRestore(
  checkout: CheckpointCheckout,
  conversationId: string,
  seq: number
): Promise<CheckpointRestorePreview> {
  const checkpoint = await requireCheckpoint(checkout, conversationId, seq);
  const [currentTree, targetTree] = await Promise.all([
    snapshotTree(checkout),
    treeOf(checkout.exec, checkpoint.hash),
  ]);
  const changes = await diffTrees(checkout.exec, currentTree, targetTree);
  return {
    checkpoint,
    files: changes.slice(0, PREVIEW_FILE_LIMIT).map((change) => ({
      path: change.path,
      change: changeKind(change),
    })),
    ...countByKind(changes),
    truncated: changes.length > PREVIEW_FILE_LIMIT,
  };
}

function isInside(root: string, candidate: string): boolean {
  return (
    candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  );
}

async function removeWorkingFile(root: string, relativePath: PortableRelativePath): Promise<void> {
  const segments = relativePath.split('/');
  const name = segments.pop();
  if (!name) throw new InvalidCheckoutPathError(relativePath);
  let parent: string;
  try {
    parent = await realpath(path.join(root, ...segments));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw error;
  }
  // A symlinked directory that now points outside the checkout must never be followed.
  if (!isInside(root, parent)) throw new InvalidCheckoutPathError(relativePath);
  try {
    await unlink(path.join(parent, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Remove directories that the deletion left empty; non-empty ones (ignored files) stay.
  let directory = parent;
  while (directory !== root && isInside(root, directory)) {
    try {
      await rmdir(directory);
    } catch {
      break;
    }
    directory = path.dirname(directory);
  }
}

/**
 * True when writing `change` would destroy content that no checkpoint holds. Deletions have
 * already run, so whatever still occupies the path is not part of the current snapshot, which
 * means it is ignored (or appeared mid-restore): `checkout-index -f` would silently remove a
 * directory of ignored files, or an ignored file standing where a directory is needed.
 */
async function isBlockedWrite(root: string, change: TreeChange): Promise<boolean> {
  const segments = change.path.split('/');
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] ?? '');
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw error;
    }
    if (index < segments.length - 1) {
      // A file or symlink where the restored path needs a directory.
      if (!stats.isDirectory()) return true;
      continue;
    }
    // A directory in the way always holds content we must keep. A path that exists although the
    // current snapshot does not contain it (status `A`) is an ignored file: do not overwrite it.
    return stats.isDirectory() || change.status === 'A';
  }
  return false;
}

/**
 * Brings the working files back to checkpoint `seq`. A safety checkpoint of the current state is
 * taken first (and the restore aborts if that fails), so a restore can itself be undone. Files
 * absent from the snapshot are deleted; ignored files, the index, HEAD, and the branch stay put.
 * A path whose restore would destroy ignored content is left untouched and returned in `skipped`.
 */
export async function restoreCheckpoint(
  checkout: CheckpointCheckout,
  conversationId: string,
  seq: number
): Promise<RestoreCheckpointResult> {
  const target = await requireCheckpoint(checkout, conversationId, seq);
  const safety = await createCheckpoint(checkout, {
    conversationId,
    kind: 'safety',
    label: `Geri sarmadan önce (#${seq})`,
    protectSeq: seq,
  });
  const [currentTree, targetTree] = await Promise.all([
    treeOf(checkout.exec, safety.hash),
    treeOf(checkout.exec, target.hash),
  ]);
  const changes = await diffTrees(checkout.exec, currentTree, targetTree);
  const root = await realpath(checkout.checkoutRoot);

  // Deletions first so a file can become a directory (and the reverse) in one restore.
  for (const change of changes) {
    if (change.status === 'D') await removeWorkingFile(root, change.path);
  }
  const skipped: PortableRelativePath[] = [];
  const applied: TreeChange[] = [];
  for (const change of changes) {
    if (change.status !== 'D' && (await isBlockedWrite(root, change))) skipped.push(change.path);
    else applied.push(change);
  }
  const writes = applied.filter((change) => change.status !== 'D').map((change) => change.path);
  if (writes.length > 0) {
    await withTempIndex(checkout, false, async (env) => {
      await checkout.exec.exec(['read-tree', targetTree], { env });
      for (let start = 0; start < writes.length; start += CHECKOUT_INDEX_CHUNK) {
        await checkout.exec.exec(
          [
            'checkout-index',
            '-f',
            '-q',
            '--',
            ...writes.slice(start, start + CHECKOUT_INDEX_CHUNK),
          ],
          { env }
        );
      }
    });
  }
  return { safetySeq: safety.seq, ...countByKind(applied), skipped };
}

/** Removes every checkpoint ref of a conversation; objects are left to git's own gc. */
export async function deleteCheckpoints(
  checkout: CheckpointCheckout,
  conversationId: string
): Promise<number> {
  const checkpoints = await listCheckpoints(checkout, conversationId);
  for (const checkpoint of checkpoints) {
    await deleteRef(checkout.exec, refFor(conversationId, checkpoint.seq));
  }
  return checkpoints.length;
}
