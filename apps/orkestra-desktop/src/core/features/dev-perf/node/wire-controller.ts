import { err, map, ok, type Result } from '@orkestra/shared';
import type { Logger } from '@orkestra/shared/logger';
import { setVerboseSpawnLogging } from '@orkestra/shared/perf';
import { createController, type Controller } from '@orkestra/wire/rpc';
import {
  devPerfContract,
  type DevPerfProcess,
  type DevPerfSignalError,
  type DevPerfTraceError,
} from '../api';
import { PROCESS_SNAPSHOT_SUPPORTED, snapshotProcessTree } from './process-snapshot';

export type DevPerfOperations = {
  /** Record a contentTracing trace and return the file path it was written to. */
  captureTrace(durationMs: number): Promise<Result<string, DevPerfTraceError>>;
  /** Toggle verbose per-spawn logging in every worker process. */
  setWorkerSpawnLogging(enabled: boolean): void;
};

const DEFAULT_TRACE_DURATION_MS = 10_000;
const MAX_TRACE_DURATION_MS = 120_000;

export async function signalDescendantProcess(
  input: { pid: number; signal: 'SIGTERM' | 'SIGKILL' },
  deps: {
    supported?: boolean;
    snapshotTree?: () => Promise<DevPerfProcess[]>;
    killPid?: (pid: number, signal: NodeJS.Signals) => void;
  } = {}
): Promise<Result<{ signaled: true }, DevPerfSignalError>> {
  if (!(deps.supported ?? PROCESS_SNAPSHOT_SUPPORTED)) {
    return err({
      type: 'unsupported',
      message: 'Bu platformda süreç sinyali desteklenmiyor.',
    });
  }
  const tree = await (deps.snapshotTree ?? snapshotProcessTree)();
  const match = tree.find((proc) => proc.pid === input.pid);
  if (!match || match.depth <= 0) {
    return err({
      type: 'not_descendant',
      message:
        'Güvenlik nedeniyle yalnızca Orkestra alt süreçleri (depth > 0) sonlandırılabilir.',
    });
  }
  try {
    (deps.killPid ?? ((pid, sig) => process.kill(pid, sig)))(input.pid, input.signal);
    return ok({ signaled: true as const });
  } catch (error) {
    return err({
      type: 'signal_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createDevPerfWireController(
  operations: DevPerfOperations,
  logger: Logger
): Controller {
  let verboseSpawnLogging = false;

  return createController(devPerfContract, {
    processSnapshot: async () => ({
      supported: PROCESS_SNAPSHOT_SUPPORTED,
      processes: await snapshotProcessTree(),
    }),
    captureTrace: async ({ durationMs }) => {
      const clamped = Math.min(
        MAX_TRACE_DURATION_MS,
        Math.max(1_000, durationMs ?? DEFAULT_TRACE_DURATION_MS)
      );
      return map(await operations.captureTrace(clamped), (path) => ({ path }));
    },
    setVerboseSpawnLogging: ({ enabled }) => {
      verboseSpawnLogging = enabled;
      setVerboseSpawnLogging(logger, enabled);
      operations.setWorkerSpawnLogging(enabled);
      return { enabled };
    },
    getVerboseSpawnLogging: () => ({ enabled: verboseSpawnLogging }),
    signalProcess: (input) => signalDescendantProcess(input),
  });
}
