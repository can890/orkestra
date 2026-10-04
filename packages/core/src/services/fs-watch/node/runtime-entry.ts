import { runWireComponentWorker } from '@orkestra/wire/worker';
import { initWorkerProcessLogging } from '@orkestra/wire/worker/node';
import { fsWatchComponent } from './component';

const logger = initWorkerProcessLogging('fs-watch-runtime');
void runWireComponentWorker(fsWatchComponent, { logger });
