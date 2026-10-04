import { runWireComponentWorker } from '@orkestra/wire/worker';
import { initWorkerProcessLogging } from '@orkestra/wire/worker/node';
import { workspaceRegistryComponent } from './component';

const logger = initWorkerProcessLogging('workspace-registry-runtime');
void runWireComponentWorker(workspaceRegistryComponent, { logger });
