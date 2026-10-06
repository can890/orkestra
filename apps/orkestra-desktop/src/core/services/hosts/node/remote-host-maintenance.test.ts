import type { WireInitializeResult } from '@orkestra/core/workspace-server';
import { createScope } from '@orkestra/shared/concurrency';
import { ManualClock } from '@orkestra/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import { HostMaintenanceModel } from './maintenance-model';
import { RemoteHostMaintenance } from './remote-host-maintenance';
import { workspaceServerLayout } from './workspace-server/layout';
import type { RawVersionListing } from './workspace-server/maintenance/host-health';
import type { ServerActivitySources } from './workspace-server/maintenance/server-activity';

const layout = workspaceServerLayout('/home/me');

function handshake(appVersion: string): WireInitializeResult {
  return {
    protocolVersion: '10.1.0',
    agreedVersion: '10.1.0',
    agreedMinor: 1,
    server: { appVersion, daemonId: 'd', startedAt: 500 },
  };
}

function createFixture(
  options: {
    running?: string;
    available?: string;
    busy?: boolean;
    autoUpdate?: boolean;
    listing?: RawVersionListing;
  } = {}
) {
  const scope = createScope({ label: 'test' });
  const clock = new ManualClock(1_000);
  const model = new HostMaintenanceModel();
  let running = options.running ?? '1.2.3';
  let ready = true;
  let busy = options.busy ?? false;
  const sources: ServerActivitySources = {
    acpSessions: async () => ({}),
    tuiSessions: async () => ({}),
    terminals: async () =>
      busy
        ? ({
            t1: {
              key: { id: 't1', workspace: { path: { root: { kind: 'posix' }, segments: ['r'] } } },
              status: 'running',
              startCount: 1,
              cols: 1,
              rows: 1,
              startedAt: 0,
            },
          } as never)
        : {},
    scriptRuns: async () => [],
    scriptDevServers: async () => ({}),
  };
  const availableVersion = vi.fn(async () => options.available ?? '1.2.4');
  const install = vi.fn(async () => {});
  const restart = vi.fn(async () => {
    running = options.available ?? '1.2.4';
  });
  const listing: RawVersionListing = options.listing ?? {
    currentTarget: 'versions/1.2.3',
    versions: [{ name: '1.2.3', kib: 1 }],
  };
  const health = {
    inspect: vi.fn(async () => listing),
    prune: vi.fn(async () => ({ removed: ['1.0.0'], freedBytes: 5 })),
  };
  const maintenance = new RemoteHostMaintenance({
    connectionId: 'ssh-1',
    scope,
    model,
    clock,
    attachment: () => (ready ? { handshake: handshake(running), sources } : undefined),
    layout: async () => layout,
    availableVersion,
    install,
    restart,
    health,
    autoUpdate: options.autoUpdate,
    intervals: { checkMs: 6_000, busyRecheckMs: 1_000, startupDelayMs: 100 },
  });
  return {
    maintenance,
    clock,
    availableVersion,
    install,
    restart,
    health,
    state: () => model.get('ssh-1'),
    setBusy: (value: boolean) => {
      busy = value;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    dispose: () => scope.dispose(),
  };
}

describe('RemoteHostMaintenance', () => {
  it('updates an idle server automatically and records the update', async () => {
    const fixture = createFixture();
    await fixture.maintenance.check('auto');

    expect(fixture.install).toHaveBeenCalledWith(layout, '1.2.4', expect.any(AbortSignal));
    expect(fixture.restart).toHaveBeenCalledTimes(1);
    expect(fixture.state()).toMatchObject({
      status: 'up-to-date',
      runningVersion: '1.2.4',
      availableVersion: '1.2.4',
      lastUpdate: { from: '1.2.3', to: '1.2.4', automatic: true },
    });
    await fixture.dispose();
  });

  it('does not interrupt a busy server and marks the update as waiting', async () => {
    const fixture = createFixture({ busy: true });
    await fixture.maintenance.check('auto');

    expect(fixture.install).not.toHaveBeenCalled();
    expect(fixture.restart).not.toHaveBeenCalled();
    expect(fixture.state()).toMatchObject({
      status: 'waiting-for-idle',
      availableVersion: '1.2.4',
      activity: { items: [{ kind: 'terminal', id: 't1' }], complete: true },
    });

    // Sunucu boşa çıkınca meşgul yeniden denetimi güncellemeyi tamamlar.
    fixture.setBusy(false);
    await fixture.clock.advanceBy(1_000);
    await vi.waitFor(() => expect(fixture.restart).toHaveBeenCalledTimes(1));
    await fixture.dispose();
  });

  it('skips the restart when work starts while the new version installs', async () => {
    const fixture = createFixture();
    fixture.install.mockImplementationOnce(async () => {
      fixture.setBusy(true);
    });
    await fixture.maintenance.check('auto');

    expect(fixture.install).toHaveBeenCalledTimes(1);
    expect(fixture.restart).not.toHaveBeenCalled();
    expect(fixture.state()?.status).toBe('waiting-for-idle');
    await fixture.dispose();
  });

  it('only reports availability when automatic updates are disabled', async () => {
    const fixture = createFixture({ autoUpdate: false });
    await fixture.maintenance.check('auto');
    expect(fixture.install).not.toHaveBeenCalled();
    expect(fixture.state()?.status).toBe('update-available');
    await fixture.dispose();
  });

  it('never auto-updates dev builds or up-to-date servers', async () => {
    const dev = createFixture({ running: '1.2.3-dev.abc', available: '1.2.4' });
    await dev.maintenance.check('auto');
    expect(dev.state()?.status).toBe('dev-build');
    expect(dev.install).not.toHaveBeenCalled();
    await dev.dispose();

    const current = createFixture({ running: '1.2.4', available: '1.2.4' });
    await current.maintenance.check('auto');
    expect(current.state()?.status).toBe('up-to-date');
    expect(current.install).not.toHaveBeenCalled();
    await current.dispose();
  });

  it('does not retry a failed automatic update to the same version', async () => {
    const fixture = createFixture();
    fixture.install.mockRejectedValueOnce(new Error('download failed'));
    await fixture.maintenance.check('auto');
    expect(fixture.state()).toMatchObject({ status: 'failed' });
    expect(fixture.state()?.error).toContain('download failed');

    await fixture.maintenance.check('auto');
    expect(fixture.install).toHaveBeenCalledTimes(1);
    expect(fixture.state()?.status).toBe('failed');
    await fixture.dispose();
  });

  it('updates a busy server when the user confirms', async () => {
    const fixture = createFixture({ busy: true });
    await fixture.maintenance.updateNow();
    expect(fixture.restart).toHaveBeenCalledTimes(1);
    expect(fixture.state()?.lastUpdate).toMatchObject({ automatic: false, to: '1.2.4' });
    await fixture.dispose();
  });

  it('rethrows a failed confirmed update', async () => {
    const fixture = createFixture();
    fixture.restart.mockRejectedValueOnce(new Error('daemon did not start'));
    await expect(fixture.maintenance.updateNow()).rejects.toThrow('daemon did not start');
    expect(fixture.state()?.status).toBe('failed');
    await fixture.dispose();
  });

  it('schedules a check after readiness and repeats it periodically', async () => {
    const fixture = createFixture({ running: '1.2.4', available: '1.2.4' });
    fixture.maintenance.onReady();
    expect(fixture.state()).toMatchObject({ runningVersion: '1.2.4', daemonStartedAt: 500 });
    await fixture.clock.advanceBy(100);
    await vi.waitFor(() => expect(fixture.health.inspect).toHaveBeenCalledTimes(1));
    expect(fixture.availableVersion).toHaveBeenCalledTimes(1);
    // İlk denetimin tamamen bitmesini bekle; aksi halde yeni denetim onunla birleşir.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.clock.advanceBy(6_000);
    await vi.waitFor(() => expect(fixture.health.inspect).toHaveBeenCalledTimes(2));
    await fixture.dispose();
  });

  it('skips automatic checks without a ready connection and rejects manual ones', async () => {
    const fixture = createFixture();
    fixture.setReady(false);
    await fixture.maintenance.check('auto');
    expect(fixture.availableVersion).not.toHaveBeenCalled();
    await expect(fixture.maintenance.check('manual')).rejects.toThrow();
    await fixture.dispose();
  });

  it('publishes host health and prunes from a fresh listing', async () => {
    const fixture = createFixture({
      running: '1.2.4',
      available: '1.2.4',
      listing: {
        currentTarget: 'versions/1.2.4',
        versions: [
          { name: '1.2.4', kib: 1 },
          { name: '1.2.3', kib: 1 },
          { name: '1.0.0', kib: 2 },
        ],
        rootKib: 10,
      },
    });
    await fixture.maintenance.inspectHealth();
    expect(fixture.state()?.health).toMatchObject({ rootBytes: 10_240, prunableBytes: 2_048 });

    const result = await fixture.maintenance.prune();
    expect(result).toEqual({ removed: ['1.0.0'], freedBytes: 5 });
    expect(fixture.health.prune).toHaveBeenCalledWith(
      layout,
      expect.objectContaining({ prunableBytes: 2_048 }),
      '1.2.4',
      expect.any(AbortSignal)
    );
    expect(fixture.health.inspect).toHaveBeenCalledTimes(3);
    expect(fixture.state()?.pruning).toBeUndefined();
    await fixture.dispose();
  });
});
