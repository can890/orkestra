import { createEmitter, type Unsubscribe } from '@orkestra/shared';
import type { Scope } from '@orkestra/shared/concurrency';
import type { Logger } from '@orkestra/shared/logger';
import { forwardWorkerLogs } from './logging';
import { isWorkerPoolMessage, workerPoolLoad, workerPoolMemberMessage } from './pool-protocol';
import { isWorkerSignal } from './protocol';
import type { ProcessExit, WorkerProcess, WorkerProcessSpawner, WorkerProcessSpec } from './types';
import { WORKER_NAME_ENV_VAR } from './types';

const DEFAULT_MAX_POOL_CRASHES = 2;

export type PooledProcessSpawnerOptions = {
  /** Owns the pool host processes; must outlive every worker that joins a pool. */
  scope: Scope;
  /** Spawns both the pool host processes and the workers that stay dedicated. */
  inner: WorkerProcessSpawner;
  /** Entry script that calls `runWorkerPoolHost()`. */
  hostEntry: string;
  /**
   * Names the pool a worker joins. Returning `undefined` keeps the worker in a
   * dedicated process, exactly as without pooling.
   */
  poolFor(spec: WorkerProcessSpec): string | undefined;
  logger?: Logger;
  /**
   * A pool whose host process dies on its own this many times stops pooling:
   * its workers fall back to dedicated processes so one crash-looping member
   * cannot keep taking its poolmates down. Defaults to 2.
   */
  maxPoolCrashes?: number;
};

/**
 * Decorates a {@link WorkerProcessSpawner} so several workers share one host
 * process instead of each paying for its own runtime. Every worker still gets
 * its own {@link WorkerProcess}: messages are multiplexed over the host's IPC
 * channel and a member ending is reported as that worker's exit, so
 * supervision, bootstrap, and Wire links work unchanged.
 *
 * What a pool gives up is fault isolation between its members. A member that
 * ends normally (or fails and reports it) only ends itself, but a crash of the
 * host process ends every member, and force-killing one member means killing
 * the host. Pool only workers that tolerate restarting together.
 */
export function pooledProcessSpawner(options: PooledProcessSpawnerOptions): WorkerProcessSpawner {
  const pools = new Map<string, WorkerPool>();

  return {
    async spawn(spec: WorkerProcessSpec, scope: Scope): Promise<WorkerProcess> {
      const poolName = spec.args?.length ? undefined : options.poolFor(spec);
      if (poolName === undefined) return await options.inner.spawn(spec, scope);

      let pool = pools.get(poolName);
      if (!pool) {
        pool = new WorkerPool(poolName, options);
        pools.set(poolName, pool);
      }
      if (pool.abandoned) return await options.inner.spawn(spec, scope);
      return await pool.spawn(spec);
    },
  };
}

type PoolMember = {
  readonly id: number;
  readonly messages: ReturnType<typeof createEmitter<unknown>>;
  readonly exits: ReturnType<typeof createEmitter<ProcessExit>>;
  readonly exited: Promise<void>;
  resolveExited(): void;
  finished: boolean;
  /** The parent sent the shutdown signal; the member is inside its grace period. */
  stopping: boolean;
  killRequested: boolean;
};

type PoolHost = {
  readonly process: WorkerProcess;
  readonly members: Map<number, PoolMember>;
  /** The parent ended this host on purpose; its exit is not a crash. */
  retired: boolean;
};

class WorkerPool {
  private host: PoolHost | undefined;
  private starting: Promise<PoolHost> | undefined;
  private nextMemberId = 0;
  private crashes = 0;
  private readonly logger: Logger | undefined;

  constructor(
    private readonly name: string,
    private readonly options: PooledProcessSpawnerOptions
  ) {
    this.logger = options.logger?.child({ workerPool: name });
  }

  get abandoned(): boolean {
    return this.crashes >= (this.options.maxPoolCrashes ?? DEFAULT_MAX_POOL_CRASHES);
  }

  async spawn(spec: WorkerProcessSpec): Promise<WorkerProcess> {
    const host = await this.ensureHost(spec);
    const member = createMember(++this.nextMemberId);
    host.members.set(member.id, member);
    host.process.send(
      workerPoolLoad(member.id, spec.entry, spec.env?.[WORKER_NAME_ENV_VAR] ?? spec.entry)
    );
    return this.memberProcess(host, member);
  }

  private ensureHost(spec: WorkerProcessSpec): Promise<PoolHost> {
    if (this.host) return Promise.resolve(this.host);
    this.starting ??= this.startHost(spec).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startHost(spec: WorkerProcessSpec): Promise<PoolHost> {
    const process = await this.options.inner.spawn(
      {
        entry: this.options.hostEntry,
        env: { ...spec.env, [WORKER_NAME_ENV_VAR]: `pool-${this.name}` },
        cwd: spec.cwd,
      },
      this.options.scope
    );
    const host: PoolHost = { process, members: new Map(), retired: false };

    process.onMessage((message) => {
      if (!isWorkerPoolMessage(message)) return;
      const member = host.members.get(message.member);
      if (!member) return;
      if (message.event === 'message') {
        member.messages.emit(message.payload);
        return;
      }
      if (message.event === 'exit') {
        this.finishMember(host, member, { code: message.code, signal: null });
        if (host.members.size === 0) this.retireHost(host);
        else this.settleDeferredKills(host);
      }
    });
    if (this.logger) forwardWorkerLogs(process, this.logger, { source: `pool-${this.name}` });
    process.onExit((exit) => {
      if (this.host === host) this.host = undefined;
      if (!host.retired) {
        this.crashes += 1;
        this.logger?.error('worker pool host exited unexpectedly', {
          ...exit,
          members: host.members.size,
          crashes: this.crashes,
          poolingAbandoned: this.abandoned,
        });
      }
      for (const member of [...host.members.values()]) this.finishMember(host, member, exit);
    });

    this.host = host;
    return host;
  }

  private memberProcess(host: PoolHost, member: PoolMember): WorkerProcess {
    return {
      get pid() {
        return host.process.pid;
      },
      send: (message) => {
        if (member.finished) return;
        if (isWorkerSignal(message, 'shutdown')) member.stopping = true;
        host.process.send(workerPoolMemberMessage(member.id, message));
      },
      onMessage: (cb): Unsubscribe => member.messages.subscribe(cb),
      onExit: (cb): Unsubscribe => member.exits.subscribe(cb),
      // The host's stdio is shared by every member and forwarded once, by the pool.
      onStdio: (): Unsubscribe => () => {},
      kill: (): Promise<void> | void => {
        if (member.finished) return;
        member.killRequested = true;
        this.settleDeferredKills(host);
        return member.exited;
      },
    };
  }

  private finishMember(host: PoolHost, member: PoolMember, exit: ProcessExit): void {
    if (member.finished) return;
    member.finished = true;
    host.members.delete(member.id);
    member.exits.emit(exit);
    member.messages.clear();
    member.exits.clear();
    member.resolveExited();
  }

  /**
   * A member that must be force-killed can only be killed with its host. While
   * other members are still inside their own shutdown grace period the kill
   * waits for them, so an orderly stop of the whole pool is not cut short by
   * its slowest member's shorter deadline.
   */
  private settleDeferredKills(host: PoolHost): void {
    if (host.retired) return;
    const members = [...host.members.values()];
    if (!members.some((member) => member.killRequested)) return;
    if (members.some((member) => member.stopping && !member.killRequested)) return;
    const collateral = members.filter((member) => !member.killRequested).length;
    if (collateral > 0) {
      this.logger?.warn('killing worker pool host to stop an unresponsive member', { collateral });
    }
    this.retireHost(host);
  }

  private retireHost(host: PoolHost): void {
    if (host.retired) return;
    host.retired = true;
    if (this.host === host) this.host = undefined;
    void Promise.resolve(host.process.kill()).catch(() => undefined);
  }
}

function createMember(id: number): PoolMember {
  let resolveExited: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  return {
    id,
    messages: createEmitter<unknown>(),
    exits: createEmitter<ProcessExit>(),
    exited,
    resolveExited,
    finished: false,
    stopping: false,
    killRequested: false,
  };
}
