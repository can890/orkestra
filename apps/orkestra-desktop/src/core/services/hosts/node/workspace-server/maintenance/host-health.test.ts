import { describe, expect, it, vi } from 'vitest';
import { workspaceServerLayout } from '../layout';
import {
  buildHealthInspectionScript,
  buildPruneScript,
  classifyVersions,
  parseHealthInspection,
  parsePruneOutput,
  RemoteHostHealthInspector,
  summarizeHealth,
} from './host-health';

const layout = workspaceServerLayout("/home/o'brien");

describe('classifyVersions', () => {
  const versions = ['1.4.0', '1.3.0', '1.2.0', '1.1.0'].map((name) => ({ name, bytes: 10 }));

  it('keeps current and the newest other version; prunes the rest', () => {
    const { entries, pruneBlockedReason } = classifyVersions({
      versions,
      currentVersion: '1.4.0',
      runningVersion: '1.4.0',
    });
    expect(entries.map((entry) => [entry.name, entry.role])).toEqual([
      ['1.4.0', 'current'],
      ['1.3.0', 'previous'],
      ['1.2.0', 'prunable'],
      ['1.1.0', 'prunable'],
    ]);
    expect(pruneBlockedReason).toBeUndefined();
  });

  it('treats a running version that differs from current as the rollback point', () => {
    const { entries } = classifyVersions({
      versions,
      currentVersion: '1.4.0',
      runningVersion: '1.2.0',
    });
    expect(entries.map((entry) => [entry.name, entry.role])).toEqual([
      ['1.4.0', 'current'],
      ['1.3.0', 'prunable'],
      ['1.2.0', 'running'],
      ['1.1.0', 'prunable'],
    ]);
  });

  it('never prunes unrecognized directories', () => {
    const { entries } = classifyVersions({
      versions: [{ name: '1.4.0' }, { name: 'notes' }, { name: '1.3.0' }, { name: '1.2.0' }],
      currentVersion: '1.4.0',
      runningVersion: undefined,
    });
    expect(entries.map((entry) => entry.role)).toEqual([
      'current',
      'unrecognized',
      'previous',
      'prunable',
    ]);
  });

  it('prunes nothing when the current version is unknown', () => {
    const { entries, pruneBlockedReason } = classifyVersions({
      versions,
      currentVersion: undefined,
      runningVersion: '1.4.0',
    });
    expect(entries.some((entry) => entry.role === 'prunable')).toBe(false);
    expect(pruneBlockedReason).toBeDefined();
  });
});

describe('health inspection', () => {
  it('quotes every layout path in the inspection script', () => {
    const script = buildHealthInspectionScript(layout);
    expect(script).toContain(`root='/home/o'\\''brien/.orkestra/workspace-server'`);
    expect(script).toContain('ls -1t --');
    expect(script).not.toContain('rm ');
  });

  it('parses the listing and summarizes sizes and prunable bytes', () => {
    const listing = parseHealthInspection(
      [
        'current\tversions/1.3.0',
        'version\t1.3.0\t100',
        'version\t1.2.0\t90',
        'version\t1.1.0\t80',
        'version\t1.0.0\t',
        'root\t400',
        'free\t2048',
        '',
      ].join('\n')
    );
    const health = summarizeHealth(layout, listing, '1.3.0', 42);
    expect(health).toEqual({
      checkedAt: 42,
      rootBytes: 400 * 1024,
      freeBytes: 2048 * 1024,
      versions: [
        { name: '1.3.0', bytes: 100 * 1024, role: 'current' },
        { name: '1.2.0', bytes: 90 * 1024, role: 'previous' },
        { name: '1.1.0', bytes: 80 * 1024, role: 'prunable' },
        { name: '1.0.0', role: 'prunable' },
      ],
      prunableBytes: 80 * 1024,
    });
  });

  it('blocks pruning when the current link points outside versions/', () => {
    const listing = parseHealthInspection('current\t/tmp/1.3.0\nversion\t1.3.0\t1\n');
    expect(summarizeHealth(layout, listing, undefined, 0).pruneBlockedReason).toBeDefined();
  });
});

describe('pruning', () => {
  it('builds a locked script that re-checks current and running before deleting', () => {
    const script = buildPruneScript(layout, ['1.1.0', '1.0.0'], '1.3.0');
    expect(script).toContain(`lock='/home/o'\\''brien/.orkestra/workspace-server/install.lock'`);
    expect(script).toContain('if ! mkdir -- "$lock"');
    expect(script).toContain('running=1.3.0\n');
    expect(script).toContain('for name in 1.1.0 1.0.0; do');
    expect(script).toContain('[ "$name" = "$current_name" ] || [ "$name" = "$running" ]');
  });

  it('rejects names that are not workspace-server versions', () => {
    expect(() => buildPruneScript(layout, ['../current'], undefined)).toThrow();
    expect(() => buildPruneScript(layout, ['1.0.0; rm -rf ~'], undefined)).toThrow();
    expect(() => buildPruneScript(layout, [], undefined)).toThrow();
  });

  it('parses removed versions', () => {
    expect(parsePruneOutput('removed\t1.1.0\nskipped\t1.3.0\nremoved\t1.0.0\n')).toEqual([
      '1.1.0',
      '1.0.0',
    ]);
  });

  it('only sends prunable versions and reports freed bytes', async () => {
    const execScript = vi.fn(async () => ({
      stdout: 'removed\t1.1.0\n',
      stderr: '',
      exitCode: 0,
    }));
    const inspector = new RemoteHostHealthInspector('ssh-1', {
      ensureProxy: async () => ({ execScript }) as never,
    });
    const result = await inspector.prune(
      layout,
      {
        checkedAt: 0,
        prunableBytes: 30,
        versions: [
          { name: '1.3.0', role: 'current', bytes: 10 },
          { name: '1.2.0', role: 'previous', bytes: 20 },
          { name: '1.1.0', role: 'prunable', bytes: 30 },
        ],
      },
      '1.3.0'
    );
    expect(result).toEqual({ removed: ['1.1.0'], freedBytes: 30 });
    const script = (execScript.mock.calls[0] as unknown as [string])[0];
    expect(script).toContain('for name in 1.1.0; do');
    expect(script).not.toContain('1.2.0');
  });

  it('does not run anything when nothing is prunable or pruning is blocked', async () => {
    const ensureProxy = vi.fn();
    const inspector = new RemoteHostHealthInspector('ssh-1', { ensureProxy });
    await expect(
      inspector.prune(layout, { checkedAt: 0, prunableBytes: 0, versions: [] }, undefined)
    ).resolves.toEqual({ removed: [], freedBytes: 0 });
    await expect(
      inspector.prune(
        layout,
        { checkedAt: 0, prunableBytes: 0, versions: [], pruneBlockedReason: 'x' },
        undefined
      )
    ).rejects.toThrow('x');
    expect(ensureProxy).not.toHaveBeenCalled();
  });

  it('reports a concurrent install as a retryable failure', async () => {
    const inspector = new RemoteHostHealthInspector('ssh-1', {
      ensureProxy: async () =>
        ({ execScript: async () => ({ stdout: '', stderr: 'busy', exitCode: 43 }) }) as never,
    });
    await expect(
      inspector.prune(
        layout,
        { checkedAt: 0, prunableBytes: 1, versions: [{ name: '1.0.0', role: 'prunable' }] },
        undefined
      )
    ).rejects.toThrow('kurulumu sürüyor');
  });
});
