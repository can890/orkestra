import { describe, expect, it } from 'vitest';
import { HistoryRefreshTrigger } from './history-refresh-trigger';

const suspended = { lifecycle: 'closed' as const, historyRevision: undefined };
const starting = { lifecycle: 'starting' as const, historyRevision: undefined };
const replaying = { lifecycle: 'replaying' as const, historyRevision: 0 };

/** What one failed wake looks like from the desktop: provisional activation, then suspended. */
function failedWake(trigger: HistoryRefreshTrigger): boolean[] {
  return [starting, replaying, suspended].map((state) => trigger.observe(state, false));
}

describe('HistoryRefreshTrigger', () => {
  it('does not re-read history after the provider could not restore the session', () => {
    // Regression: the flip between the provisional activation (revision 0) and the suspended
    // state (no revision) counted as a history change, so every failed restore requested another
    // history read, which woke the session and failed again every ~2 seconds without end.
    const trigger = new HistoryRefreshTrigger(suspended);
    trigger.markRestoreFailed();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(failedWake(trigger)).toEqual([false, false, false]);
    }
    expect(trigger.blockedByRestoreFailure).toBe(true);
  });

  it('refreshes again once a live activation proves the session is back', () => {
    const trigger = new HistoryRefreshTrigger(suspended);
    trigger.markRestoreFailed();
    trigger.observe(replaying, false);
    expect(trigger.observe({ lifecycle: 'ready', historyRevision: 0 }, false)).toBe(true);
    expect(trigger.blockedByRestoreFailure).toBe(false);
    expect(trigger.observe({ lifecycle: 'ready', historyRevision: 1 }, false)).toBe(true);
  });

  it('a running turn or an explicit reset also lifts the block', () => {
    const working = new HistoryRefreshTrigger(suspended);
    working.markRestoreFailed();
    working.observe({ lifecycle: 'working', historyRevision: 0 }, false);
    expect(working.blockedByRestoreFailure).toBe(false);

    const retried = new HistoryRefreshTrigger(suspended);
    retried.markRestoreFailed();
    retried.reset();
    expect(retried.observe(replaying, false)).toBe(true);
  });

  it('keeps the normal triggers without a restore failure', () => {
    const trigger = new HistoryRefreshTrigger({ lifecycle: 'ready', historyRevision: 2 });
    expect(trigger.observe({ lifecycle: 'working', historyRevision: 2 }, false)).toBe(false);
    expect(trigger.observe({ lifecycle: 'ready', historyRevision: 3 }, false)).toBe(true);
    trigger.observe({ lifecycle: 'replaying', historyRevision: 3 }, false);
    expect(trigger.observe({ lifecycle: 'ready', historyRevision: 3 }, true)).toBe(false);
  });
});
