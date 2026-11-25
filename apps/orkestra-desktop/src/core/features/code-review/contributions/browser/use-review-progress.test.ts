import { describe, expect, it } from 'vitest';
import { isReviewFileViewed } from '@core/features/code-review/api/review-guide';

describe('PR file review progress', () => {
  it('matches local progress and resets the mark when file content changes', () => {
    expect(isReviewFileViewed('next', 'prior', undefined)).toBe(false);
    expect(isReviewFileViewed('next', 'next', undefined)).toBe(true);
    expect(isReviewFileViewed('next', undefined, undefined)).toBe(false);
  });

  it('imports native marks and invalidates dismissed, changed and unmarked files', () => {
    expect(isReviewFileViewed('next', undefined, true)).toBe(true);
    expect(isReviewFileViewed('next', 'prior', true)).toBe(false);
    expect(isReviewFileViewed('next', 'next', true)).toBe(true);
    expect(isReviewFileViewed('next', 'next', false)).toBe(false);
  });
});
