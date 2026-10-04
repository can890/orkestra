import { runWireComponentWorker } from '@orkestra/wire/worker';
import { initWorkerProcessLogging } from '@orkestra/wire/worker/node';
import { fileSearchComponent } from './component';

const logger = initWorkerProcessLogging('file-search-runtime');
void runWireComponentWorker(fileSearchComponent, { logger });
