import { describe, expect, it } from 'vitest';
import { COMPUTER_USE_ACTIVE_GRACE_MS, isComputerUseActive } from './computer-use-chip';

describe('isComputerUseActive', () => {
  const now = 1_000_000;

  it('is active while the agent is working, even with no recent action', () => {
    expect(isComputerUseActive({ working: true, lastActionAt: undefined, now })).toBe(true);
    expect(isComputerUseActive({ working: true, lastActionAt: now - 3_600_000, now })).toBe(true);
  });

  it('stays active for a short grace period after the last action', () => {
    expect(isComputerUseActive({ working: false, lastActionAt: now - 1_000, now })).toBe(true);
    expect(
      isComputerUseActive({
        working: false,
        lastActionAt: now - COMPUTER_USE_ACTIVE_GRACE_MS + 1,
        now,
      })
    ).toBe(true);
  });

  it('is idle once the agent stopped and the grace period passed', () => {
    expect(
      isComputerUseActive({ working: false, lastActionAt: now - COMPUTER_USE_ACTIVE_GRACE_MS, now })
    ).toBe(false);
    expect(isComputerUseActive({ working: false, lastActionAt: now - 5 * 3_600_000, now })).toBe(
      false
    );
    expect(isComputerUseActive({ working: false, lastActionAt: undefined, now })).toBe(false);
  });
});
