import {
  gitErr,
  type CheckoutSelector,
  type GitCommandError,
} from '@orkestra/core/runtimes/git/api';
import type { Result } from '@orkestra/shared';
import type { Logger } from '@orkestra/shared/logger';
import { hostPathFromNative } from '@core/primitives/desktop-runtime/api';
import type { ConversationsHostRuntimesClient } from '../api/runtime-adapter';

/** A snapshot of a large worktree can take a while; the prompt is never held longer than this. */
export const PROMPT_CHECKPOINT_TIMEOUT_MS = 30_000;

export type CheckpointTarget = Readonly<{
  conversationId: string;
  workspacePath?: string | undefined;
}>;

type GitClient = ConversationsHostRuntimesClient['git'];

/** Selector for the conversation's worktree, or null while the worktree is not provisioned. */
export function checkpointSelector(target: CheckpointTarget): CheckoutSelector | null {
  return target.workspacePath ? { checkout: hostPathFromNative(target.workspacePath) } : null;
}

/** Runs `work` against the conversation's worktree, or fails when it is not provisioned. */
export async function withCheckpointSelector<T>(
  target: CheckpointTarget,
  work: (selector: CheckoutSelector) => Promise<Result<T, GitCommandError>>
): Promise<Result<T, GitCommandError>> {
  const selector = checkpointSelector(target);
  if (!selector) return gitErr.commandFailed('Bu sohbetin çalışma ağacı henüz hazır değil');
  return work(selector);
}

/**
 * Snapshots the worktree just before a user prompt is delivered. Never throws and never blocks
 * the prompt on failure: a missing checkpoint only means that message cannot be rewound.
 */
export async function takePromptCheckpoint(
  git: GitClient | undefined,
  target: CheckpointTarget,
  promptId: string,
  logger: Pick<Logger, 'warn'>,
  warned: Set<string>,
  signal?: AbortSignal
): Promise<void> {
  const selector = checkpointSelector(target);
  if (!git || !selector) return;
  try {
    const result = await git.checkout.createCheckpoint(
      { ...selector, conversationId: target.conversationId, promptId, kind: 'prompt' },
      { timeoutMs: PROMPT_CHECKPOINT_TIMEOUT_MS, ...(signal ? { signal } : {}) }
    );
    if (result.success) return;
    warnOnce(logger, warned, target.conversationId, result.error);
  } catch (error) {
    warnOnce(logger, warned, target.conversationId, error);
  }
}

/** Removes the conversation's checkpoint refs; the worktree may already be gone, which is fine. */
export async function deleteConversationCheckpoints(
  git: GitClient | undefined,
  target: CheckpointTarget,
  logger: Pick<Logger, 'warn'>,
  warned: Set<string>
): Promise<void> {
  const selector = checkpointSelector(target);
  if (!git || !selector) return;
  try {
    const result = await git.checkout.deleteCheckpoints({
      ...selector,
      conversationId: target.conversationId,
    });
    if (!result.success) {
      logger.warn('Failed to delete conversation checkpoints', {
        conversationId: target.conversationId,
        error: result.error,
      });
    }
  } catch (error) {
    logger.warn('Failed to delete conversation checkpoints', {
      conversationId: target.conversationId,
      error: String(error),
    });
  } finally {
    warned.delete(target.conversationId);
  }
}

function warnOnce(
  logger: Pick<Logger, 'warn'>,
  warned: Set<string>,
  conversationId: string,
  error: unknown
): void {
  if (warned.has(conversationId)) return;
  warned.add(conversationId);
  logger.warn('Could not take a checkpoint before the prompt; rewind is unavailable for it', {
    conversationId,
    error: error instanceof Error ? error.message : error,
  });
}
