import type { SessionState } from '@orkestra/core/runtimes/acp/api/client';

/**
 * Decides when a live session-state change should re-read committed history.
 *
 * A history read can wake a suspended conversation. When the provider cannot restore the saved
 * session, the runtime publishes the provisional activation (history revision 0, `replaying`) and
 * then the suspended state again (no revision). Treating that flip as "history changed" re-read the
 * history, which woke the session again and failed again — an endless loop every ~2 seconds that
 * never surfaced beyond the error line. After such a restore failure, state changes stop requesting
 * refreshes until a live activation proves the session is back (a finished replay or a running
 * turn) or the caller resets the trigger (explicit retry, reattachment).
 */
export class HistoryRefreshTrigger {
  private previousLifecycle: SessionState['lifecycle'];
  private previousHistoryRevision: number | undefined;
  private restoreFailed = false;

  constructor(initial: Pick<SessionState, 'lifecycle' | 'historyRevision'>) {
    this.previousLifecycle = initial.lifecycle;
    this.previousHistoryRevision = initial.historyRevision;
  }

  get blockedByRestoreFailure(): boolean {
    return this.restoreFailed;
  }

  /** Records a failed history read that could not restore the provider session. */
  markRestoreFailed(): void {
    this.restoreFailed = true;
  }

  /** An explicit retry, a reattachment, or a successful history read allows refreshes again. */
  reset(): void {
    this.restoreFailed = false;
  }

  /** Returns true when this state change should request a history refresh. */
  observe(
    state: Pick<SessionState, 'lifecycle' | 'historyRevision'>,
    historyLoading: boolean
  ): boolean {
    const replayCompleted = this.previousLifecycle === 'replaying' && state.lifecycle === 'ready';
    const historyChanged = this.previousHistoryRevision !== state.historyRevision;
    this.previousLifecycle = state.lifecycle;
    this.previousHistoryRevision = state.historyRevision;
    if (replayCompleted || state.lifecycle === 'working') this.restoreFailed = false;
    if (this.restoreFailed) return false;
    return historyChanged || (replayCompleted && !historyLoading);
  }
}
