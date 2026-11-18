const WORKER_POOL_KIND = 'wire-worker-pool';

/** Parent → pool host: evaluate a worker entry as a new pool member. */
export type WorkerPoolLoad = {
  kind: typeof WORKER_POOL_KIND;
  event: 'load';
  member: number;
  entry: string;
  name: string;
};

/** Either direction: one message on a member's virtual IPC channel. */
export type WorkerPoolMemberMessage = {
  kind: typeof WORKER_POOL_KIND;
  event: 'message';
  member: number;
  payload: unknown;
};

/** Pool host → parent: a member ended, as if its process had exited. */
export type WorkerPoolMemberExit = {
  kind: typeof WORKER_POOL_KIND;
  event: 'exit';
  member: number;
  code: number;
};

export type WorkerPoolMessage = WorkerPoolLoad | WorkerPoolMemberMessage | WorkerPoolMemberExit;

export function workerPoolLoad(member: number, entry: string, name: string): WorkerPoolLoad {
  return { kind: WORKER_POOL_KIND, event: 'load', member, entry, name };
}

export function workerPoolMemberMessage(member: number, payload: unknown): WorkerPoolMemberMessage {
  return { kind: WORKER_POOL_KIND, event: 'message', member, payload };
}

export function workerPoolMemberExit(member: number, code: number): WorkerPoolMemberExit {
  return { kind: WORKER_POOL_KIND, event: 'exit', member, code };
}

export function isWorkerPoolMessage(message: unknown): message is WorkerPoolMessage {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as Record<string, unknown>;
  return record.kind === WORKER_POOL_KIND && typeof record.member === 'number';
}
