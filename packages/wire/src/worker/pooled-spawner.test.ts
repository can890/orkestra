import { createScope, type Scope } from '@orkestra/shared/concurrency';
import { retrySchedules } from '@orkestra/shared/scheduling';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineContract, procedure } from '../api/define';
import { createController } from '../rpc/controller';
import { FakeWorkerProcessSpawner, type FakeWorkerProcess } from '../testing';
import { defineWireComponent } from './component';
import { createWireWorkerHost } from './host';
import { runWorkerPoolHost } from './node/run-worker-pool-host';
import { pooledProcessSpawner } from './pooled-spawner';
import { runWireComponentWorker } from './run-component-worker';
import type { WorkerProcess, WorkerProcessSpawner, WorkerProcessSpec } from './types';
import { WORKER_NAME_ENV_VAR } from './types';

const HOST_ENTRY = '/app/pool-host.js';

const api = defineContract({
  ping: procedure({ input: z.string(), output: z.string() }),
});

function pingComponent(id: string, options: { hangOnDispose?: boolean } = {}) {
  return defineWireComponent({
    id,
    contract: api,
    requirements: {},
    configSchema: z.object({}),
    create: ({ instance, scope }) => {
      if (options.hangOnDispose) scope.add(() => new Promise<void>(() => {}));
      return instance({
        scope,
        controller: createController(api, { ping: (input) => `${id}:${input}` }),
      });
    },
  });
}

const alpha = pingComponent('alpha');
const beta = pingComponent('beta');
const solo = pingComponent('solo');
const stuck = pingComponent('stuck', { hangOnDispose: true });

const components = { alpha, beta, solo, stuck } as const;
type ComponentId = keyof typeof components;

/**
 * Stands in for real child processes: a spawned pool host runs the real
 * `runWorkerPoolHost` over the fake IPC channel, and "importing" an entry runs
 * the matching component exactly as its runtime entry file would.
 */
class PoolTestSpawner implements WorkerProcessSpawner {
  readonly fake = new FakeWorkerProcessSpawner();
  readonly imports: string[] = [];

  async spawn(spec: WorkerProcessSpec, scope: Scope): Promise<WorkerProcess> {
    const process = (await this.fake.spawn(spec, scope)) as FakeWorkerProcess;
    if (spec.entry === HOST_ENTRY) {
      runWorkerPoolHost({
        parent: process.childPort,
        exitProcess: (code) => process.emitExit({ code }),
        importEntry: async (url) => {
          this.imports.push(url);
          void runWireComponentWorker(components[componentIdOf(url)]);
        },
      });
    } else {
      void runWireComponentWorker(components[componentIdOf(spec.entry)], {
        port: process.childPort,
        exit: (code) => process.emitExit({ code }),
      });
    }
    return process;
  }

  get hosts(): FakeWorkerProcess[] {
    return this.fake.processes.filter((process) => process.spec.entry === HOST_ENTRY);
  }

  get dedicated(): FakeWorkerProcess[] {
    return this.fake.processes.filter((process) => process.spec.entry !== HOST_ENTRY);
  }
}

function componentIdOf(entry: string): ComponentId {
  const match = /\/([a-z]+)\.js(\?.*)?$/.exec(entry);
  if (!match || !(match[1] in components)) throw new Error(`Unknown test entry '${entry}'`);
  return match[1] as ComponentId;
}

function createHarness(options: { maxPoolCrashes?: number } = {}) {
  const spawner = new PoolTestSpawner();
  const scope = createScope({ label: 'root' });
  const host = createWireWorkerHost({
    scope,
    processSpawner: pooledProcessSpawner({
      scope,
      inner: spawner,
      hostEntry: HOST_ENTRY,
      poolFor: (spec) => (spec.env?.[WORKER_NAME_ENV_VAR] === 'solo' ? undefined : 'shared'),
      maxPoolCrashes: options.maxPoolCrashes,
    }),
  });
  const create = (id: ComponentId, shutdownGraceMs = 1_000) =>
    host.create(components[id], {
      name: id,
      executable: `/app/${id}.js`,
      dependencies: {},
      config: {},
      shutdownGraceMs,
      supervision: { restart: 'on-failure', schedule: retrySchedules.sequence([0, 0, 0]) },
    });
  return { spawner, host, create };
}

describe('pooledProcessSpawner', () => {
  it('hosts pooled workers in one process and leaves the others dedicated', async () => {
    const { spawner, host, create } = createHarness();

    const [alphaClient, betaClient, soloClient] = await Promise.all([
      create('alpha').ready(),
      create('beta').ready(),
      create('solo').ready(),
    ]);

    await expect(alphaClient.ping('one')).resolves.toBe('alpha:one');
    await expect(betaClient.ping('two')).resolves.toBe('beta:two');
    await expect(soloClient.ping('three')).resolves.toBe('solo:three');
    expect(spawner.hosts).toHaveLength(1);
    expect(spawner.hosts[0].spec.env?.[WORKER_NAME_ENV_VAR]).toBe('pool-shared');
    expect(spawner.dedicated.map((process) => process.spec.entry)).toEqual(['/app/solo.js']);

    await host.dispose();
  });

  it('stops one member without disturbing its poolmate and retires an empty host', async () => {
    const { spawner, host, create } = createHarness();
    const alphaWorker = create('alpha');
    const betaWorker = create('beta');
    await alphaWorker.ready();
    const betaClient = await betaWorker.ready();
    const hostExits: unknown[] = [];
    spawner.hosts[0].onExit((exit) => hostExits.push(exit));

    await alphaWorker.stop();

    expect(alphaWorker.state.kind).toBe('idle');
    expect(betaWorker.state.kind).toBe('ready');
    await expect(betaClient.ping('still')).resolves.toBe('beta:still');
    expect(hostExits).toEqual([]);

    await betaWorker.stop();
    await waitFor(() => hostExits.length === 1);

    await host.dispose();
  });

  it('re-evaluates the entry when a member restarts inside a live host', async () => {
    const { spawner, host, create } = createHarness();
    const alphaWorker = create('alpha');
    await create('beta').ready();
    await alphaWorker.ready();

    await alphaWorker.restart();
    const client = await alphaWorker.ready();

    await expect(client.ping('again')).resolves.toBe('alpha:again');
    expect(spawner.hosts).toHaveLength(1);
    const alphaImports = spawner.imports.filter((url) => url.includes('/alpha.js'));
    expect(alphaImports).toHaveLength(2);
    expect(new Set(alphaImports).size).toBe(2);

    await host.dispose();
  });

  it('restarts every member in a fresh host when the host process crashes', async () => {
    const { spawner, host, create } = createHarness();
    const alphaWorker = create('alpha');
    const betaWorker = create('beta');
    await alphaWorker.ready();
    await betaWorker.ready();

    spawner.hosts[0].emitExit({ code: null, signal: 'SIGSEGV' });
    await waitFor(
      () =>
        spawner.hosts.length === 2 &&
        alphaWorker.state.kind === 'ready' &&
        betaWorker.state.kind === 'ready'
    );

    await expect((await alphaWorker.ready()).ping('back')).resolves.toBe('alpha:back');
    await expect((await betaWorker.ready()).ping('back')).resolves.toBe('beta:back');
    expect(spawner.dedicated).toHaveLength(0);

    await host.dispose();
  });

  it('falls back to dedicated processes once a pool keeps crashing', async () => {
    const { spawner, host, create } = createHarness({ maxPoolCrashes: 1 });
    const alphaWorker = create('alpha');
    const betaWorker = create('beta');
    await alphaWorker.ready();
    await betaWorker.ready();

    spawner.hosts[0].emitExit({ code: 1 });
    await waitFor(
      () =>
        spawner.dedicated.length === 2 &&
        alphaWorker.state.kind === 'ready' &&
        betaWorker.state.kind === 'ready'
    );

    expect(spawner.hosts).toHaveLength(1);
    expect(spawner.dedicated.map((process) => process.spec.entry).sort()).toEqual([
      '/app/alpha.js',
      '/app/beta.js',
    ]);
    await expect((await alphaWorker.ready()).ping('alone')).resolves.toBe('alpha:alone');

    await host.dispose();
  });

  it('kills the host to stop an unresponsive member, restarting its poolmates', async () => {
    const { spawner, host, create } = createHarness();
    const stuckWorker = create('stuck', 0);
    const betaWorker = create('beta');
    await stuckWorker.ready();
    await betaWorker.ready();

    await stuckWorker.stop();

    expect(stuckWorker.state.kind).toBe('idle');
    await waitFor(() => spawner.hosts.length === 2 && betaWorker.state.kind === 'ready');
    await expect((await betaWorker.ready()).ping('fresh')).resolves.toBe('beta:fresh');

    await host.dispose();
  });

  it('lets a poolmate finish its own shutdown before killing for a stuck member', async () => {
    const { spawner, host, create } = createHarness();
    const stuckWorker = create('stuck', 0);
    const betaWorker = create('beta', 10_000);
    await stuckWorker.ready();
    await betaWorker.ready();
    const hostExits: unknown[] = [];
    spawner.hosts[0].onExit((exit) => hostExits.push(exit));
    const betaStates: string[] = [];
    betaWorker.onStateChanged((state) => betaStates.push(state.kind));

    await Promise.all([stuckWorker.stop(), betaWorker.stop()]);

    // Beta left through its own graceful exit, never through a restart.
    expect(betaStates).toEqual(['stopping', 'idle']);
    expect(hostExits).toHaveLength(1);
    expect(spawner.hosts).toHaveLength(1);

    await host.dispose();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}
