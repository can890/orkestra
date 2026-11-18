import { pathToFileURL } from 'node:url';
import type { Unsubscribe } from '@orkestra/shared';
import type { Logger } from '@orkestra/shared/logger';
import { setCurrentHostedWorker, type HostedWorkerContext } from '../hosted';
import {
  isWorkerPoolMessage,
  workerPoolMemberExit,
  workerPoolMemberMessage,
  type WorkerPoolLoad,
} from '../pool-protocol';
import type { WorkerParentPort } from '../types';

const DEFAULT_DISCONNECT_GRACE_MS = 5_000;

export type RunWorkerPoolHostOptions = {
  logger?: Logger;
  /** Channel to the parent; defaults to the process IPC channel. */
  parent?: WorkerParentPort;
  /** Evaluates a worker entry; defaults to a dynamic `import()`. */
  importEntry?: (url: string) => Promise<unknown>;
  exitProcess?: (code: number) => void;
  /** How long members get to shut down after the parent disappears. */
  disconnectGraceMs?: number;
};

type HostedMember = {
  readonly id: number;
  readonly messageListeners: Set<(message: unknown) => void>;
  readonly disconnectListeners: Set<() => void>;
  /** Messages that arrived before the entry finished evaluating. */
  pending: unknown[] | null;
  exited: boolean;
};

/**
 * Child-process side of a worker pool: evaluates worker entries on request and
 * gives each one a virtual parent port multiplexed over this process's single
 * IPC channel. A member "exiting" only ends that member; the process itself
 * stays up for its poolmates until the parent retires it.
 */
export function runWorkerPoolHost(options: RunWorkerPoolHostOptions = {}): void {
  const parent = options.parent ?? processParentPort();
  const importEntry =
    options.importEntry ??
    // oxlint-disable-next-line orkestra/no-dynamic-imports -- a pool host exists to evaluate worker entries chosen by the parent at runtime
    ((url: string) => import(url));
  const exitProcess = options.exitProcess ?? ((code: number) => process.exit(code));
  const logger = options.logger;
  const members = new Map<number, HostedMember>();
  const entryLoads = new Map<string, number>();
  let loadQueue: Promise<void> = Promise.resolve();
  let parentGone = false;

  const sendToParent = (message: unknown): void => {
    if (parentGone) return;
    try {
      parent.send(message);
    } catch {
      // The channel closed under us; the disconnect handler ends the members.
    }
  };

  const deliver = (member: HostedMember, payload: unknown): void => {
    for (const listener of [...member.messageListeners]) listener(payload);
  };

  const endMember = (member: HostedMember, code: number): void => {
    if (member.exited) return;
    member.exited = true;
    members.delete(member.id);
    member.messageListeners.clear();
    member.disconnectListeners.clear();
    sendToParent(workerPoolMemberExit(member.id, code));
    if (parentGone && members.size === 0) exitProcess(0);
  };

  const load = (request: WorkerPoolLoad): void => {
    const member: HostedMember = {
      id: request.member,
      messageListeners: new Set(),
      disconnectListeners: new Set(),
      pending: [],
      exited: false,
    };
    members.set(member.id, member);

    const context: HostedWorkerContext = {
      name: request.name,
      logger,
      port: {
        send(message) {
          if (!member.exited) sendToParent(workerPoolMemberMessage(member.id, message));
        },
        onMessage(cb): Unsubscribe {
          member.messageListeners.add(cb);
          return () => member.messageListeners.delete(cb);
        },
        onDisconnect(cb): Unsubscribe {
          member.disconnectListeners.add(cb);
          return () => member.disconnectListeners.delete(cb);
        },
      },
      exit: (code) => endMember(member, code),
    };

    // Entries read the hosted context synchronously while they evaluate, so
    // only one entry may be evaluating at a time.
    loadQueue = loadQueue.then(async () => {
      if (member.exited) return;
      setCurrentHostedWorker(context);
      try {
        await importEntry(entryUrl(request.entry));
      } catch (error) {
        logger?.error('worker pool member failed to load', {
          member: request.name,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        endMember(member, 1);
      } finally {
        setCurrentHostedWorker(undefined);
        const pending = member.pending ?? [];
        member.pending = null;
        for (const payload of pending) deliver(member, payload);
      }
    });
  };

  // A module is evaluated once per URL, so a member that restarts inside a
  // live host needs a fresh URL for its entry to run again. Shared chunks keep
  // their plain URLs and stay cached.
  const entryUrl = (entry: string): string => {
    const loads = entryLoads.get(entry) ?? 0;
    entryLoads.set(entry, loads + 1);
    const href = pathToFileURL(entry).href;
    return loads === 0 ? href : `${href}?reload=${loads}`;
  };

  parent.onMessage((message) => {
    if (!isWorkerPoolMessage(message)) return;
    if (message.event === 'load') {
      load(message);
      return;
    }
    if (message.event !== 'message') return;
    const member = members.get(message.member);
    if (!member) return;
    if (member.pending) member.pending.push(message.payload);
    else deliver(member, message.payload);
  });

  parent.onDisconnect(() => {
    parentGone = true;
    if (members.size === 0) {
      exitProcess(0);
      return;
    }
    for (const member of [...members.values()]) {
      for (const listener of [...member.disconnectListeners]) listener();
    }
    setTimeout(() => exitProcess(0), options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS);
  });
}

function processParentPort(): WorkerParentPort {
  if (typeof process.send !== 'function') {
    throw new Error('runWorkerPoolHost requires an IPC channel to the parent process');
  }
  return {
    send(message) {
      process.send?.(message);
    },
    onMessage(cb) {
      process.on('message', cb);
      return () => process.off('message', cb);
    },
    onDisconnect(cb) {
      process.on('disconnect', cb);
      return () => process.off('disconnect', cb);
    },
  };
}
