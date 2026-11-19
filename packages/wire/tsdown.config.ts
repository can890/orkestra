import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    rpc: 'src/rpc/index.ts',
    live: 'src/live/index.ts',
    state: 'src/state/index.ts',
    mobx: 'src/live/mobx/index.ts',
    testing: 'src/testing/index.ts',
    worker: 'src/worker/index.ts',
    'worker-node': 'src/worker/node/index.ts',
    remote: 'src/remote/index.ts',
    'remote-node': 'src/remote/node/index.ts',
  },
  format: ['esm'],
  dts: true,
  deps: {
    neverBundle: ['@orkestra/shared', 'immer', 'mobx', 'ws', 'zod'],
  },
  sourcemap: true,
  clean: true,
});
