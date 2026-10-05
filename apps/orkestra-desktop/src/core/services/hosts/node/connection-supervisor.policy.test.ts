import { createScope } from '@orkestra/shared/concurrency';
import { deferred } from '@orkestra/shared/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SshConnectionFailure } from '@core/primitives/ssh/api/node/connection-control';
import {
  createFaultPeer,
  createSupervisorDriver,
  observePromise,
} from './testing/connection-supervisor-fixture';
import { WorkspaceServerProvisionError } from './workspace-server/provision/provisioner';

const daemonTarget = {
  kind: 'ssh' as const,
  sshConnectionId: 'acceptance-host',
  socketPath: '/workspace.sock',
};

/** The error ssh2 reports when the SSH server refuses a streamlocal channel. */
function channelOpenFailure(reason: number, description = 'open failed') {
  return Object.assign(new Error(`(SSH) Channel open failure: ${description}`), { reason });
}

/**
 * A remote daemon behind the cached socket. Like production preparation, prepare() starts an
 * absent daemon and leaves a running one alone.
 */
function createRemoteDaemon(peer: ReturnType<typeof createFaultPeer>) {
  const daemon = {
    running: true,
    /** What opening the socket reports while nothing listens on it. */
    refuse: (): Error => channelOpenFailure(2),
    starts: 0,
    prepare: vi.fn(async () => {
      if (!daemon.running) {
        daemon.running = true;
        daemon.starts += 1;
      }
      return daemonTarget;
    }),
    open: vi.fn(async () => {
      if (!daemon.running) throw daemon.refuse();
      return await peer.openTransport();
    }),
    cancel: vi.fn(),
    /** The process exits (reboot, OOM): its socket refuses and the attached channel closes. */
    exit() {
      daemon.running = false;
      peer.current.disconnect();
    },
  };
  return daemon;
}

describe('Host supervisor lifecycle policy', () => {
  let peer: ReturnType<typeof createFaultPeer>;
  let driver: ReturnType<typeof createSupervisorDriver>;
  beforeEach(() => {
    vi.useFakeTimers();
    peer = createFaultPeer();
    driver = createSupervisorDriver(peer);
  });
  afterEach(async () => {
    await driver.dispose();
    await peer.dispose();
    vi.useRealTimers();
  });

  it('readiness observation cannot acquire unowned runtime demand', async () => {
    await driver.managed.connectSsh();
    await expect(driver.supervisor.awaitUsable()).rejects.toMatchObject({
      type: 'host-unavailable',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(peer.opens).toBe(0);
  });

  it.each(['ssh', 'preparation'] as const)(
    'keeps Disconnect authoritative when %s success was already queued',
    async (phase) => {
      await driver.dispose();
      const ssh = deferred<void>();
      const target = {
        kind: 'ssh' as const,
        sshConnectionId: 'acceptance-host',
        socketPath: '/workspace.sock',
      };
      const prepared = deferred<typeof target>();
      driver = createSupervisorDriver(peer, {
        ssh: {
          connected: () => phase !== 'ssh',
          establish: () => (phase === 'ssh' ? ssh.promise : Promise.resolve()),
          reset() {},
          probe: async () => {},
        },
        runtime: {
          prepare: () => prepared.promise,
          open: () => peer.openTransport(),
          cancel() {},
        },
      });
      const connecting = driver.connect();
      await vi.advanceTimersByTimeAsync(0);

      if (phase === 'ssh') ssh.resolve();
      else prepared.resolve(target);
      // Fulfill the bounded wait first, then disconnect before recover() resumes.
      await Promise.resolve().then(() => driver.disconnect());
      await connecting;

      expect(driver.state).toEqual({ kind: 'suspended', reason: 'user-disconnected' });
      expect(peer.opens).toBe(0);
    }
  );

  it('an SSH authentication block survives a pre-existing runtime protocol block', async () => {
    peer.setProtocolVersion('999.0.0');
    await driver.connect();
    await driver.dispose();
    let connected = true;
    const establish = vi.fn(async () => {
      if (!connected) throw new SshConnectionFailure('authentication', 'Credentials rejected');
    });
    driver = createSupervisorDriver(peer, {
      ssh: {
        connected: () => connected,
        establish,
        reset: () => {
          connected = false;
        },
        probe: async () => {},
      },
    });
    await driver.connect();
    connected = false;
    driver.supervisor.sshDisconnected();
    await vi.advanceTimersByTimeAsync(0);
    const attempts = establish.mock.calls.length;
    driver.supervisor.resume();
    driver.supervisor.revalidate('online');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(establish).toHaveBeenCalledTimes(attempts);
    expect(driver.state).toMatchObject({ kind: 'unavailable', recovery: 'blocked' });
  });

  it('does not postpone health validation when readiness is repeatedly requested', async () => {
    await driver.connect();
    peer.current.dropReplies = true;
    await vi.advanceTimersByTimeAsync(10_000);
    await driver.supervisor.awaitUsable();
    await driver.supervisor.ensureSsh();
    const release = peer.stallInitialize();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(driver.state.kind).not.toBe('ready');
    release();
  });

  it('lease release cannot clear an authentication block', async () => {
    await driver.dispose();
    const establish = vi.fn(async () => {
      throw new SshConnectionFailure('authentication', 'Credentials rejected');
    });
    driver = createSupervisorDriver(peer, {
      ssh: { connected: () => false, establish, reset() {}, probe: async () => {} },
    });
    await driver.connect();
    const owner = createScope();
    driver.managed.lease(owner);
    await owner.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(establish).toHaveBeenCalledOnce();
    expect(driver.state).toMatchObject({ kind: 'unavailable', recovery: 'blocked' });
  });

  it('lease release preserves an explicitly maintained runtime', async () => {
    await driver.connect();
    const owner = createScope();
    driver.managed.lease(owner);
    await owner.dispose();
    expect(peer.current.closed).toBe(false);
    expect(driver.state.kind).toBe('ready');
  });

  it('pausing runtime settles pending readiness waiters and reports manual recovery', async () => {
    const release = peer.stallInitialize();
    const pending = observePromise(driver.connectRuntime());
    await vi.advanceTimersByTimeAsync(0);
    driver.supervisor.pauseRuntime();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.outcome).toBe('rejected');
    expect(driver.state).toMatchObject({ kind: 'unavailable', recovery: 'manual' });
    driver.supervisor.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.state).toMatchObject({ kind: 'unavailable', recovery: 'manual' });
  });

  it('keeps SSH access and SSH recovery independent of a blocked Wire protocol', async () => {
    peer.setProtocolVersion('999.0.0');
    await expect(driver.connect()).resolves.toMatchObject({ success: false });
    await expect(driver.supervisor.ensureSsh()).resolves.toBeUndefined();
    const opens = peer.opens;
    driver.supervisor.suspendSystem();
    driver.supervisor.resume();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(driver.state).toMatchObject({ kind: 'unavailable', recovery: 'blocked' });
    expect(peer.opens).toBe(opens);
    await expect(driver.supervisor.ensureSsh()).resolves.toBeUndefined();
  });

  it('does not confuse a completed intent write with the superseded pre-sleep network generation', async () => {
    await driver.dispose();
    const write = deferred<void>();
    driver = createSupervisorDriver(peer, {
      intent: { read: async () => false, write: () => write.promise },
    });
    const connecting = driver.connect();
    await vi.advanceTimersByTimeAsync(0);
    driver.supervisor.suspendSystem();
    driver.supervisor.resume();
    write.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(connecting).resolves.toMatchObject({ success: true });
  });

  it('coalesces explicit retries while cancelling backoff without superseding another Connect', async () => {
    peer.setOffline(true);
    const connecting = driver.connect();
    await vi.advanceTimersByTimeAsync(0);
    peer.setOffline(false);
    await Promise.all([driver.managed.pin(), driver.managed.pin()]);
    await vi.advanceTimersByTimeAsync(0);
    await expect(connecting).resolves.toMatchObject({ success: true });
    expect(peer.opens).toBe(2);
  });

  it('resume validates the retained channel and does not replace a healthy attachment', async () => {
    await driver.connect();
    const attachment = await driver.getAttachment();
    driver.supervisor.suspendSystem();
    expect(driver.state.kind).not.toBe('ready');
    driver.supervisor.resume();
    expect(driver.state).toMatchObject({ kind: 'preparing', phase: 'checking' });
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.state.kind).toBe('ready');
    expect(peer.opens).toBe(1);
    expect(await driver.getAttachment()).toBe(attachment);
  });

  it('resume supersedes pre-sleep initialization and closes its late candidate', async () => {
    const release = peer.stallInitialize();
    const connected = driver.connect();
    await vi.advanceTimersByTimeAsync(0);
    driver.supervisor.suspendSystem();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.state.kind).not.toBe('ready');
    expect(peer.channels[0]?.closed).toBe(true);
    driver.supervisor.resume();
    await vi.advanceTimersByTimeAsync(0);
    await expect(connected).resolves.toMatchObject({ success: true });
    expect(peer.opens).toBe(2);
  });

  it('cancelling one readiness waiter does not cancel shared recovery', async () => {
    const release = peer.stallInitialize();
    const connected = driver.connect();
    await vi.advanceTimersByTimeAsync(0);
    const abort = new AbortController();
    const cancelled = driver.supervisor.awaitUsable(abort.signal);
    const surviving = driver.supervisor.awaitUsable();
    const rejection = expect(cancelled).rejects.toThrow('Caller cancelled');
    abort.abort(new Error('Caller cancelled'));
    await rejection;
    expect(observePromise(surviving).outcome).toBe('pending');
    release();
    await vi.advanceTimersByTimeAsync(0);
    await surviving;
    await connected;
    expect(peer.opens).toBe(1);
  });

  it.each(['authentication', 'configuration', 'host-key'] as const)(
    'blocks typed %s failures including resume wakeups',
    async (kind) => {
      await driver.dispose();
      const establish = vi.fn(async () => {
        throw new SshConnectionFailure(kind, 'Action required');
      });
      driver = createSupervisorDriver(peer, {
        ssh: { connected: () => false, establish, reset() {}, probe: async () => {} },
      });
      await expect(driver.connect()).resolves.toMatchObject({ success: false });
      driver.supervisor.suspendSystem();
      driver.supervisor.resume();
      driver.revalidate('online');
      await vi.advanceTimersByTimeAsync(600_000);
      expect(driver.state).toMatchObject({ kind: 'unavailable', recovery: 'blocked' });
      expect(establish).toHaveBeenCalledOnce();
    }
  );

  it('reports a failed Disconnect write after stopping local recovery immediately', async () => {
    await driver.dispose();
    const write = vi.fn(async (enabled: boolean) => {
      if (!enabled) throw new Error('Disk unavailable');
    });
    driver = createSupervisorDriver(peer, { intent: { read: async () => true, write } });
    await driver.connect();
    await expect(driver.disconnect()).rejects.toThrow('Disk unavailable');
    expect(driver.state.kind).toBe('suspended');
    const opens = peer.opens;
    driver.revalidate('online');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(peer.opens).toBe(opens);
  });

  it('serializes intent writes so a delayed Connect cannot reverse Disconnect', async () => {
    await driver.dispose();
    const gate = deferred<void>();
    const writes: boolean[] = [];
    driver = createSupervisorDriver(peer, {
      intent: {
        read: async () => false,
        write: async (enabled) => {
          if (enabled) await gate.promise;
          writes.push(enabled);
        },
      },
    });
    const connecting = driver.connect();
    await vi.advanceTimersByTimeAsync(0);
    const disconnecting = driver.disconnect();
    gate.resolve();
    await disconnecting;
    await expect(connecting).resolves.toMatchObject({ success: false });
    expect(writes).toEqual([true, false]);
    expect(peer.opens).toBe(0);
  });

  it('maintains SSH-only intent without opening the workspace server', async () => {
    await driver.dispose();
    let connected = false;
    const probe = vi.fn(async () => {});
    driver = createSupervisorDriver(peer, {
      ssh: {
        connected: () => connected,
        establish: async () => {
          connected = true;
        },
        reset: () => {
          connected = false;
        },
        probe,
      },
    });
    await driver.managed.connectSsh();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(probe).toHaveBeenCalledOnce();
    expect(peer.opens).toBe(0);
    expect(driver.state.kind).not.toBe('ready');
  });

  it('releasing the last automatic lease cancels runtime recovery without changing SSH intent', async () => {
    const owner = createScope({ label: 'project-demand' });
    const release = peer.stallInitialize();
    driver.managed.lease(owner);
    await vi.advanceTimersByTimeAsync(0);
    await owner.dispose();
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(peer.opens).toBe(1);
    expect(peer.channels[0]?.closed).toBe(true);
    await expect(driver.supervisor.ensureSsh()).resolves.toBeUndefined();
  });

  describe('a workspace-server daemon behind the cached socket', () => {
    let daemon: ReturnType<typeof createRemoteDaemon>;
    const runtime = () => ({
      prepare: daemon.prepare,
      open: daemon.open,
      cancel: daemon.cancel,
    });
    beforeEach(async () => {
      await driver.dispose();
      daemon = createRemoteDaemon(peer);
      driver = createSupervisorDriver(peer, { runtime: runtime() });
    });

    it.each([
      ['an SSH channel-open failure', () => channelOpenFailure(2)],
      [
        'a missing local socket',
        () => Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }),
      ],
    ])('re-prepares a daemon whose socket reports %s', async (_refusal, refuse) => {
      await driver.connect();
      const attachment = await driver.getAttachment();
      daemon.refuse = refuse;
      daemon.exit();
      await vi.advanceTimersByTimeAsync(0);

      expect(driver.state.kind).toBe('ready');
      expect(daemon.starts).toBe(1);
      expect(daemon.prepare).toHaveBeenCalledTimes(2);
      // The refused socket also drops the provisioner's cached result.
      expect(daemon.cancel).toHaveBeenCalled();
      expect(daemon.open).toHaveBeenCalledTimes(3);
      expect(await driver.getAttachment()).toBe(attachment);
    });

    it('reuses a healthy daemon after channel loss without re-preparing it', async () => {
      await driver.connect();
      peer.current.disconnect();
      await vi.advanceTimersByTimeAsync(0);

      expect(driver.state.kind).toBe('ready');
      expect(daemon.prepare).toHaveBeenCalledOnce();
      expect(daemon.cancel).not.toHaveBeenCalled();
      expect(daemon.starts).toBe(0);
    });

    it('recovers a rebooted Host as soon as SSH returns instead of waiting another backoff', async () => {
      await driver.dispose();
      let reachable = true;
      let sshConnected = true;
      driver = createSupervisorDriver(peer, {
        ssh: {
          connected: () => sshConnected,
          establish: async () => {
            if (!reachable) throw new Error('Host unreachable');
            sshConnected = true;
          },
          reset: () => {
            sshConnected = false;
          },
          probe: async () => {
            if (!reachable) throw new Error('Host unreachable');
          },
        },
        runtime: runtime(),
      });
      await driver.connect();
      reachable = false;
      sshConnected = false;
      daemon.exit();
      driver.supervisor.sshDisconnected();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(driver.state).toMatchObject({ kind: 'unavailable', recovery: 'waiting' });
      expect(daemon.prepare).toHaveBeenCalledOnce();

      reachable = true;
      // The next scheduled attempt is at most one capped backoff away.
      await vi.advanceTimersByTimeAsync(30_000);

      expect(driver.state.kind).toBe('ready');
      expect(daemon.starts).toBe(1);
      expect(daemon.prepare).toHaveBeenCalledTimes(2);
    });

    it('keeps backing off while a re-prepared daemon still refuses its channel', async () => {
      await driver.connect();
      // Preparation reports success, but nothing ever listens on the socket again.
      daemon.prepare.mockImplementation(async () => daemonTarget);
      daemon.exit();
      await vi.advanceTimersByTimeAsync(0);

      // The stale cached socket is re-prepared at once; the fresh target then backs off.
      expect(daemon.prepare).toHaveBeenCalledTimes(2);
      expect(driver.state).toMatchObject({
        kind: 'unavailable',
        recovery: 'waiting',
        issue: { type: 'host-unavailable' },
      });

      await vi.advanceTimersByTimeAsync(120_000);
      // Capped backoff: 1s, 2s, 5s, 10s, 20s, then every 30s.
      expect(daemon.prepare.mock.calls.length).toBeLessThanOrEqual(10);
      const state = driver.state;
      expect(state).toMatchObject({ kind: 'unavailable', recovery: 'waiting' });
      if (state.kind === 'unavailable' && state.nextAttemptAt !== undefined)
        expect(state.nextAttemptAt - Date.now()).toBeLessThanOrEqual(30_000);
    });

    it('surfaces a failed re-preparation and stops on a permanent one', async () => {
      await driver.connect();
      daemon.prepare.mockRejectedValue(
        new WorkspaceServerProvisionError(
          'daemon-start-failed',
          'Could not start the workspace server'
        )
      );
      daemon.exit();
      await vi.advanceTimersByTimeAsync(0);
      expect(driver.state).toMatchObject({
        kind: 'unavailable',
        recovery: 'waiting',
        issue: { reason: 'daemon-start-failed' },
      });

      daemon.prepare.mockRejectedValue(
        new WorkspaceServerProvisionError(
          'unsupported-platform',
          "Could not start the workspace server: version `GLIBC_2.28' not found"
        )
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(driver.state).toMatchObject({
        kind: 'unavailable',
        recovery: 'blocked',
        issue: { reason: 'unsupported-platform' },
      });
      const preparations = daemon.prepare.mock.calls.length;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(daemon.prepare).toHaveBeenCalledTimes(preparations);
    });

    it('explicit Retry re-verifies a cached target that failed without a refusal', async () => {
      await driver.connect();
      const release = peer.stallOpen();
      peer.current.disconnect();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(driver.state).toMatchObject({ kind: 'unavailable', recovery: 'waiting' });
      expect(daemon.prepare).toHaveBeenCalledOnce();
      release();

      // The banner and Machine page Retry pin the runtime again.
      await expect(driver.managed.pin()).resolves.toMatchObject({ success: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(daemon.prepare).toHaveBeenCalledTimes(2);
      expect(daemon.starts).toBe(0);
      expect(driver.state.kind).toBe('ready');
    });

    it('Disconnect then Connect re-verifies the daemon without restarting a healthy one', async () => {
      await driver.connect();
      await driver.disconnect();
      expect(daemon.cancel).toHaveBeenCalled();
      await driver.connect();

      expect(daemon.prepare).toHaveBeenCalledTimes(2);
      expect(daemon.starts).toBe(0);
      expect(driver.state.kind).toBe('ready');
    });

    it('Connect after Disconnect starts a daemon that exited meanwhile', async () => {
      await driver.connect();
      await driver.disconnect();
      daemon.running = false;
      await driver.connect();

      expect(daemon.starts).toBe(1);
      // No refused open against the forgotten socket.
      expect(daemon.open).toHaveBeenCalledTimes(2);
      expect(driver.state.kind).toBe('ready');
    });
  });
});
