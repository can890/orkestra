import { initWorkerProcessLogging, runWorkerPoolHost } from '@orkestra/wire/worker/node';

const logger = initWorkerProcessLogging('worker-pool');
runWorkerPoolHost({ logger });
