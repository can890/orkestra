import { describe, expect, it } from 'vitest';
import { evaluateUsageCapacity } from './usage-capacity';
import type { ProviderUsage } from './usage-limits';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const MIN = 60_000;

function usage(
  windows: Array<[number, number | null]>,
  measuredAgoMs = 0,
  overrides: Partial<ProviderUsage> = {}
): ProviderUsage {
  return {
    providerId: 'claude',
    status: 'available',
    windows: windows.map(([usedPercent, resetInMs], index) => ({
      label: `w${index}`,
      usedPercent,
      ...(resetInMs === null ? {} : { resetsAt: new Date(NOW + resetInMs).toISOString() }),
    })),
    balances: [],
    source: 'test',
    measuredAt: new Date(NOW - measuredAgoMs).toISOString(),
    fetchedAt: NOW,
    ...overrides,
  };
}

describe('evaluateUsageCapacity', () => {
  it('is unknown without data or windows', () => {
    expect(evaluateUsageCapacity(null, NOW).status).toBe('unknown');
    expect(evaluateUsageCapacity(usage([]), NOW).status).toBe('unknown');
  });

  it('uses the fullest window as the binding one', () => {
    const capacity = evaluateUsageCapacity(
      usage([
        [12, 60 * MIN],
        [92, 3 * 24 * 60 * MIN],
      ]),
      NOW
    );
    expect(capacity.status).toBe('saturated');
    expect(capacity.window?.label).toBe('w1');
  });

  it('grades fresh readings as ok or tight', () => {
    expect(evaluateUsageCapacity(usage([[40, 60 * MIN]]), NOW).status).toBe('ok');
    expect(evaluateUsageCapacity(usage([[75, 60 * MIN]]), NOW).status).toBe('tight');
    expect(evaluateUsageCapacity(usage([[89.9, null]]), NOW).status).toBe('tight');
    expect(evaluateUsageCapacity(usage([[90, null]]), NOW).status).toBe('saturated');
  });

  it('ignores windows that already reset', () => {
    expect(evaluateUsageCapacity(usage([[99, -MIN]]), NOW).status).toBe('unknown');
    expect(
      evaluateUsageCapacity(
        usage([
          [99, -MIN],
          [30, 60 * MIN],
        ]),
        NOW
      ).status
    ).toBe('ok');
  });

  it('trusts stale readings only as proof of saturation', () => {
    const old = 3 * 60 * MIN;
    expect(evaluateUsageCapacity(usage([[30, 24 * 60 * MIN]], old), NOW).status).toBe('unknown');
    const saturated = evaluateUsageCapacity(usage([[98, 24 * 60 * MIN]], old), NOW);
    expect(saturated).toMatchObject({ status: 'saturated', stale: true });
  });
});
