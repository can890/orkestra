import type { DesktopWorkerId } from '@core/manifests/node/workers';

/**
 * Which desktop workers share a host process. Every worker used to run in its
 * own Node process, and the per-process runtime overhead (roughly 50 MB each)
 * dominated the app's memory footprint. Pooled workers pay that overhead once
 * per pool.
 *
 * A pool trades fault isolation for memory: a crash of the host process
 * restarts every member. So only stateless request/response and
 * database-backed runtimes are pooled. The runtimes that own live user
 * sessions (agent and terminal PTYs, running scripts) stay dedicated, and so
 * does file search, whose indexing bursts would stall its poolmates.
 */
const desktopWorkerPools: Record<DesktopWorkerId, string | null> = {
  acp: null,
  'tui-agents': null,
  terminals: null,
  scripts: null,
  'file-search': null,

  'fs-watch': 'fs',
  files: 'fs',
  git: 'fs',

  'agent-config': 'data',
  automations: 'data',
  conversations: 'data',
  'host-settings': 'data',
  mementos: 'data',
  'pull-requests': 'data',
  'resource-usage': 'data',
  'workspace-registry': 'data',
};

/**
 * Pool for the worker with the given name, or `undefined` to run it in a
 * dedicated process. `ORKESTRA_WORKER_POOLS=off` restores one process per
 * worker for debugging and as an escape hatch.
 */
export function desktopWorkerPoolFor(
  workerName: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (env.ORKESTRA_WORKER_POOLS === 'off') return undefined;
  if (workerName === undefined || !Object.hasOwn(desktopWorkerPools, workerName)) return undefined;
  return desktopWorkerPools[workerName as DesktopWorkerId] ?? undefined;
}
