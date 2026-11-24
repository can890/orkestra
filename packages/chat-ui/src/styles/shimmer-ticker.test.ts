import { describe, expect, it } from 'vitest';
import { shimmerPositionAt } from './shimmer-ticker';

describe('shimmerPositionAt', () => {
  it('sweeps from 200% towards -200% over 24 steps and wraps', () => {
    expect(shimmerPositionAt(0)).toBe('200% 0');
    expect(shimmerPositionAt(12)).toBe('0% 0');
    expect(shimmerPositionAt(24)).toBe('200% 0');
    expect(shimmerPositionAt(-1)).toBe(shimmerPositionAt(23));
    const first = Number.parseFloat(shimmerPositionAt(1));
    const second = Number.parseFloat(shimmerPositionAt(2));
    expect(first - second).toBeCloseTo(400 / 24, 5);
  });
});
