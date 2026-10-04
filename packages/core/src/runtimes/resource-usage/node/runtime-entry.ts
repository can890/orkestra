import { runWireComponentWorker } from '@orkestra/wire/worker';
import { initWorkerProcessLogging } from '@orkestra/wire/worker/node';
import { resourceUsageComponent } from './component';

const logger = initWorkerProcessLogging('resource-usage-runtime');
void runWireComponentWorker(resourceUsageComponent, { logger });
