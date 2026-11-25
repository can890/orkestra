import { describe, expect, it, vi } from 'vitest';
import type { DevPerfProcess } from '../api';
import { signalDescendantProcess } from './wire-controller';

const SAMPLE_TREE: DevPerfProcess[] = [
  { pid: 100, ppid: 1, depth: 0, cpuPercent: 12, rssBytes: 250_000_000, command: 'Orkestra' },
  {
    pid: 201,
    ppid: 100,
    depth: 1,
    cpuPercent: 55,
    rssBytes: 180_000_000,
    command: 'node worker.js',
  },
];

describe('devPerf signalDescendantProcess', () => {
  it('blocks killing depth === 0 main process and external processes', async () => {
    const killPid = vi.fn();
    const resMain = await signalDescendantProcess(
      { pid: 100, signal: 'SIGTERM' },
      { supported: true, snapshotTree: async () => SAMPLE_TREE, killPid }
    );
    expect(resMain.success).toBe(false);
    if (!resMain.success) expect(resMain.error.type).toBe('not_descendant');

    const resExternal = await signalDescendantProcess(
      { pid: 9999, signal: 'SIGKILL' },
      { supported: true, snapshotTree: async () => SAMPLE_TREE, killPid }
    );
    expect(resExternal.success).toBe(false);
    if (!resExternal.success) expect(resExternal.error.type).toBe('not_descendant');
    expect(killPid).not.toHaveBeenCalled();
  });

  it('signals verified descendant processes with depth > 0', async () => {
    const killPid = vi.fn();
    const res = await signalDescendantProcess(
      { pid: 201, signal: 'SIGTERM' },
      { supported: true, snapshotTree: async () => SAMPLE_TREE, killPid }
    );
    expect(res).toEqual({ success: true, data: { signaled: true } });
    expect(killPid).toHaveBeenCalledWith(201, 'SIGTERM');
  });
});
