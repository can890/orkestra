import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutoReviewScheduler,
  changeFingerprint,
  decideAutoReview,
  MAX_AUTO_REVIEWS_PER_HOUR,
  type AutoReviewDecisionInput,
} from './auto-review';

const NOW = 1_000_000_000;

function input(overrides: Partial<AutoReviewDecisionInput> = {}): AutoReviewDecisionInput {
  return {
    enabled: true,
    reviewRunning: false,
    agentWorking: false,
    fingerprintBefore: 'before',
    fingerprintNow: 'after',
    headBefore: 'aaa',
    headNow: 'aaa',
    hasUncommittedChanges: true,
    lastReviewedFingerprint: null,
    recentAutoReviews: [],
    now: NOW,
    preferredScope: 'uncommitted',
    ...overrides,
  };
}

describe('decideAutoReview', () => {
  it('starts a review when the turn produced changes', () => {
    expect(decideAutoReview(input())).toEqual({ kind: 'start', scope: 'uncommitted' });
  });

  it.each([
    [{ enabled: false }, 'disabled'],
    [{ reviewRunning: true }, 'review-running'],
    [{ agentWorking: true }, 'agent-working'],
    [{ fingerprintNow: null }, 'status-unknown'],
    [{ fingerprintBefore: 'same', fingerprintNow: 'same' }, 'no-changes'],
    [{ fingerprintBefore: null, hasUncommittedChanges: false }, 'no-changes'],
    [{ lastReviewedFingerprint: 'after' }, 'already-reviewed'],
  ] as const)('skips for %o', (overrides, reason) => {
    expect(decideAutoReview(input(overrides))).toEqual({ kind: 'skip', reason });
  });

  it('never runs a second review while one is running, even with new changes', () => {
    expect(
      decideAutoReview(input({ reviewRunning: true, lastReviewedFingerprint: 'older' }))
    ).toEqual({ kind: 'skip', reason: 'review-running' });
  });

  it('reviews visible changes when the turn start was not observed', () => {
    expect(decideAutoReview(input({ fingerprintBefore: null }))).toEqual({
      kind: 'start',
      scope: 'uncommitted',
    });
  });

  it('rate-limits automatic reviews per hour', () => {
    const recent = Array.from(
      { length: MAX_AUTO_REVIEWS_PER_HOUR },
      (_, index) => NOW - index * 1000
    );
    expect(decideAutoReview(input({ recentAutoReviews: recent }))).toEqual({
      kind: 'skip',
      reason: 'rate-limited',
    });
    const stale = recent.map((timestamp) => timestamp - 2 * 60 * 60_000);
    expect(decideAutoReview(input({ recentAutoReviews: stale })).kind).toBe('start');
  });

  it('reviews the new commit when the agent committed everything', () => {
    expect(
      decideAutoReview(input({ hasUncommittedChanges: false, headBefore: 'aaa', headNow: 'bbb' }))
    ).toEqual({ kind: 'start', scope: 'last-commit' });
  });

  it('keeps the preferred branch scope', () => {
    expect(decideAutoReview(input({ preferredScope: 'branch' }))).toEqual({
      kind: 'start',
      scope: 'branch',
    });
  });
});

describe('changeFingerprint', () => {
  it('is independent of change order and sensitive to HEAD and content', () => {
    const a = { path: 'a.ts', status: 'modified', additions: 1, deletions: 0 };
    const b = { path: 'b.ts', status: 'added', additions: 3, deletions: 0 };
    expect(changeFingerprint({ headOid: 'h', changes: [a, b] })).toBe(
      changeFingerprint({ headOid: 'h', changes: [b, a] })
    );
    expect(changeFingerprint({ headOid: 'h', changes: [a] })).not.toBe(
      changeFingerprint({ headOid: 'h2', changes: [a] })
    );
    expect(changeFingerprint({ headOid: 'h', changes: [a] })).not.toBe(
      changeFingerprint({ headOid: 'h', changes: [{ ...a, additions: 2 }] })
    );
  });
});

describe('AutoReviewScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once after the debounce, coalescing consecutive turn ends', () => {
    const onFire = vi.fn();
    const scheduler = new AutoReviewScheduler({ debounceMs: 1000, onFire });
    scheduler.turnFinished();
    vi.advanceTimersByTime(600);
    scheduler.turnFinished();
    vi.advanceTimersByTime(600);
    expect(onFire).not.toHaveBeenCalled();
    expect(scheduler.pending).toBe(true);
    vi.advanceTimersByTime(400);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(false);
  });

  it('cancels a pending review when a new turn starts', () => {
    const onFire = vi.fn();
    const scheduler = new AutoReviewScheduler({ debounceMs: 1000, onFire });
    scheduler.turnFinished();
    scheduler.turnStarted();
    vi.advanceTimersByTime(5000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it('does nothing after dispose', () => {
    const onFire = vi.fn();
    const scheduler = new AutoReviewScheduler({ debounceMs: 1000, onFire });
    scheduler.turnFinished();
    scheduler.dispose();
    scheduler.turnFinished();
    vi.advanceTimersByTime(5000);
    expect(onFire).not.toHaveBeenCalled();
  });
});
