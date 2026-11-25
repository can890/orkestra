import { describe, expect, it } from 'vitest';
import { reconcileReviewLedger } from './use-review-progress';

describe('PR file review progress', () => {
  it('imports GitHub marks, preserves unchanged revisions, and keeps changed files unread', () => {
    const prior = new Map([
      ['unchanged.ts', 'rev-1'],
      ['changed.ts', 'rev-before'],
      ['dismissed.ts', 'rev-1'],
      ['unmarked.ts', 'rev-1'],
    ]);
    const actual = new Map([
      ['unchanged.ts', 'rev-1'],
      ['changed.ts', 'rev-after'],
      ['dismissed.ts', 'rev-2'],
      ['unmarked.ts', 'rev-1'],
      ['external.ts', 'rev-1'],
    ]);

    expect(
      reconcileReviewLedger(prior, actual, [
        { path: 'unchanged.ts', state: 'VIEWED' },
        { path: 'changed.ts', state: 'VIEWED' },
        { path: 'dismissed.ts', state: 'DISMISSED' },
        { path: 'unmarked.ts', state: 'UNVIEWED' },
        { path: 'external.ts', state: 'VIEWED' },
      ])
    ).toEqual(
      new Map([
        ['unchanged.ts', 'rev-1'],
        ['changed.ts', 'rev-before'],
        ['external.ts', 'rev-1'],
      ])
    );
  });
});
