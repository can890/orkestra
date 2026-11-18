import type { Logger } from '@orkestra/shared/logger';
import type { WorkerParentPort } from './types';

/**
 * A worker entry normally owns its whole process: it talks to the parent over
 * the process IPC channel and ends by exiting the process. Inside a worker
 * pool several entries share one process, so each one is handed a virtual
 * parent port and a virtual exit instead.
 *
 * The pool host publishes the context for the entry it is about to evaluate;
 * the entry's top-level code (`initWorkerProcessLogging`,
 * `runWireComponentWorker`) reads it synchronously while the module evaluates.
 * The registry lives on `globalThis` so it is shared even if the bundler ever
 * duplicates this module across chunks.
 */
export type HostedWorkerContext = {
  readonly name: string;
  readonly port: WorkerParentPort;
  /** Logger of the pool process; member loggers derive from it. */
  readonly logger?: Logger;
  exit(code: number): void;
};

const HOSTED_WORKER_KEY = Symbol.for('orkestra.wire.hosted-worker');

type HostedWorkerRegistry = { [HOSTED_WORKER_KEY]?: HostedWorkerContext };

export function currentHostedWorker(): HostedWorkerContext | undefined {
  return (globalThis as HostedWorkerRegistry)[HOSTED_WORKER_KEY];
}

export function setCurrentHostedWorker(context: HostedWorkerContext | undefined): void {
  if (context) {
    (globalThis as HostedWorkerRegistry)[HOSTED_WORKER_KEY] = context;
    return;
  }
  delete (globalThis as HostedWorkerRegistry)[HOSTED_WORKER_KEY];
}
