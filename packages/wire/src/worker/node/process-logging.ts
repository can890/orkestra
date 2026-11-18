import type { Logger } from '@orkestra/shared/logger';
import { initProcessLogging } from '@orkestra/shared/logger/node';
import { startDevPerfInstruments } from '@orkestra/shared/perf';
import { currentHostedWorker } from '../hosted';
import { WORKER_NAME_ENV_VAR } from '../types';
import { installWorkerVitals } from './vitals';

export function initWorkerProcessLogging(fallbackName: string): Logger {
  // A pooled worker shares its process with the pool host, which already owns
  // process logging and perf instruments; the member only needs its own name
  // on its log lines and its own vitals hookup on its virtual port.
  const hosted = currentHostedWorker();
  if (hosted?.logger) {
    const memberLogger = hosted.logger.child({ proc: hosted.name });
    installWorkerVitals({ logger: memberLogger, port: hosted.port });
    return memberLogger;
  }

  const logger = initProcessLogging({
    name: process.env[WORKER_NAME_ENV_VAR] ?? fallbackName,
  });
  // Dev-only spawn/RSS reporting; a no-op unless debug logging is enabled.
  startDevPerfInstruments({ logger });
  // Telemetry vitals + verbose spawn logging: inert until the host sends a
  // control message; no timers or instruments are created before then.
  installWorkerVitals({ logger });
  return logger;
}
