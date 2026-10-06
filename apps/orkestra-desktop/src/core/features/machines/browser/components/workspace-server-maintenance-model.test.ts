import { describe, expect, it } from 'vitest';
import {
  canUpdateNow,
  formatBytes,
  formatRelativeTime,
  formatUptime,
  interruptionSummary,
  maintenanceStatusView,
} from './workspace-server-maintenance-model';

describe('workspace-server maintenance view model', () => {
  it('maps statuses to Turkish labels and pill variants', () => {
    expect(maintenanceStatusView('waiting-for-idle')).toMatchObject({
      label: 'Boşta olmasını bekliyor',
      variant: 'warning',
    });
    expect(maintenanceStatusView('updating').pulsing).toBe(true);
    expect(maintenanceStatusView('failed').variant).toBe('error');
  });

  it('enables the update button only for a known newer version outside running work', () => {
    expect(canUpdateNow(undefined)).toBe(false);
    expect(
      canUpdateNow({ status: 'up-to-date', runningVersion: '1.0.0', availableVersion: '1.0.0' })
    ).toBe(false);
    expect(
      canUpdateNow({
        status: 'waiting-for-idle',
        runningVersion: '1.0.0',
        availableVersion: '1.1.0',
      })
    ).toBe(true);
    expect(
      canUpdateNow({ status: 'updating', runningVersion: '1.0.0', availableVersion: '1.1.0' })
    ).toBe(false);
  });

  it('summarizes what an update would interrupt', () => {
    expect(interruptionSummary({ checkedAt: 0, items: [], complete: true })).toBeNull();
    expect(
      interruptionSummary({
        checkedAt: 0,
        complete: false,
        items: [
          { kind: 'agent-turn', id: 'a', label: 'Fix bug' },
          { kind: 'terminal', id: 't', label: 'repo' },
        ],
      })
    ).toEqual({ items: ['Ajan turu: Fix bug', 'Terminal: repo'], incomplete: true });
  });

  it('formats sizes, uptime and relative times', () => {
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(300 * 1024 * 1024)).toBe('300 MB');
    expect(formatUptime(0, (2 * 24 * 60 + 3 * 60 + 5) * 60_000)).toBe('2 gün 3 sa');
    expect(formatUptime(0, 65 * 60_000)).toBe('1 sa 5 dk');
    expect(formatRelativeTime(undefined, 0)).toBe('Henüz denetlenmedi');
    expect(formatRelativeTime(0, 30_000)).toBe('az önce');
    expect(formatRelativeTime(0, 3 * 60 * 60_000)).toBe('3 sa önce');
  });
});
