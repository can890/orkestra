import { describe, expect, it } from 'vitest';
import { desktopWorkers } from '@core/manifests/node/workers';
import { desktopWorkerPoolFor } from './worker-pools';

const SESSION_OWNING_WORKERS = ['acp', 'tui-agents', 'terminals', 'scripts'];

describe('desktopWorkerPoolFor', () => {
  it('keeps the runtimes that own live user sessions in dedicated processes', () => {
    for (const worker of SESSION_OWNING_WORKERS) {
      expect(desktopWorkerPoolFor(worker, {})).toBeUndefined();
    }
  });

  it('pools the remaining runtimes into fewer processes than workers', () => {
    const pooled = Object.keys(desktopWorkers).filter(
      (worker) => desktopWorkerPoolFor(worker, {}) !== undefined
    );
    const pools = new Set(pooled.map((worker) => desktopWorkerPoolFor(worker, {})));

    expect(pooled.length).toBeGreaterThan(pools.size);
    expect(desktopWorkerPoolFor('git', {})).toBe(desktopWorkerPoolFor('files', {}));
  });

  it('runs every worker dedicated when pooling is switched off', () => {
    for (const worker of Object.keys(desktopWorkers)) {
      expect(desktopWorkerPoolFor(worker, { ORKESTRA_WORKER_POOLS: 'off' })).toBeUndefined();
    }
  });

  it('leaves unknown workers dedicated', () => {
    expect(desktopWorkerPoolFor('not-a-worker', {})).toBeUndefined();
    expect(desktopWorkerPoolFor(undefined, {})).toBeUndefined();
  });
});
