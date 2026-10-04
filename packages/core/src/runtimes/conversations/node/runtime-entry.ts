import { runWireComponentWorker } from '@orkestra/wire/worker';
import { initWorkerProcessLogging } from '@orkestra/wire/worker/node';
import { conversationsComponent } from './component';

const logger = initWorkerProcessLogging('conversations-runtime');
void runWireComponentWorker(conversationsComponent, { logger });
