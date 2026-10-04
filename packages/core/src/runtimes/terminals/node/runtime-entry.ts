import { runWireComponentWorker } from '@orkestra/wire/worker';
import { initWorkerProcessLogging } from '@orkestra/wire/worker/node';
import { terminalsComponent } from './component';

const logger = initWorkerProcessLogging('terminals-runtime');
void runWireComponentWorker(terminalsComponent, { logger });
