import { runWireComponentWorker } from '@orkestra/wire/worker';
import { initWorkerProcessLogging } from '@orkestra/wire/worker/node';
import { hostSettingsComponent } from './component';

const logger = initWorkerProcessLogging('host-settings-runtime');
void runWireComponentWorker(hostSettingsComponent, { logger });
