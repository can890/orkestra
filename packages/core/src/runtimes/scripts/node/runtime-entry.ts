import { runWireComponentWorker } from '@orkestra/wire/worker';
import { initWorkerProcessLogging } from '@orkestra/wire/worker/node';
import { scriptsComponent } from './component';

const logger = initWorkerProcessLogging('scripts-runtime');
void runWireComponentWorker(scriptsComponent, { logger });
