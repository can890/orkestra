import { describe, expect, it } from 'vitest';
import { pickLeastLoadedMachine } from './least-loaded-machine';

describe('pickLeastLoadedMachine', () => {
  it('picks the connected machine with the lowest weighted cpu/memory score', () => {
    const picked = pickLeastLoadedMachine([
      { id: 'offline', connected: false, cpuPercent: 1, memoryPercent: 1 },
      { id: 'heavy', connected: true, cpuPercent: 85, memoryPercent: 75 },
      { id: 'light', connected: true, cpuPercent: 12, memoryPercent: 40 },
      { id: 'medium', connected: true, cpuPercent: 30, memoryPercent: 35 },
    ]);
    expect(picked).toBe('light');
  });

  it('returns null when no connected machines have metrics', () => {
    expect(
      pickLeastLoadedMachine([
        { id: 'a', connected: false, cpuPercent: 10, memoryPercent: 10 },
        { id: 'b', connected: true },
      ])
    ).toBeNull();
  });
});
