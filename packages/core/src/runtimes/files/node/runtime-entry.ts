import { runWireComponentWorker } from '@orkestra/wire/worker';
import { initWorkerProcessLogging } from '@orkestra/wire/worker/node';
import { filesComponent } from './component';

const logger = initWorkerProcessLogging('files-runtime');
void runWireComponentWorker(filesComponent, { logger });
