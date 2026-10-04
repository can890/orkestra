import { runWireComponentWorker } from '@orkestra/wire/worker';
import { initWorkerProcessLogging } from '@orkestra/wire/worker/node';
import { createAutomationsComponent } from './component';

const logger = initWorkerProcessLogging('automations-runtime');
void runWireComponentWorker(createAutomationsComponent(), { logger });
