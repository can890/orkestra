import { runWireComponentWorker } from '@orkestra/wire/worker';
import { initWorkerProcessLogging } from '@orkestra/wire/worker/node';
import { gitComponent } from './component';

const logger = initWorkerProcessLogging('git-runtime');
void runWireComponentWorker(gitComponent, { logger });
