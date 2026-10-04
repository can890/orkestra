import { createAcpComponent } from '@orkestra/core/runtimes/acp/node';
import { pluginRegistry } from '@orkestra/plugins/agents';
import { runWireComponentWorker } from '@orkestra/wire/worker';
import { initWorkerProcessLogging } from '@orkestra/wire/worker/node';

const logger = initWorkerProcessLogging('acp-runtime');
void runWireComponentWorker(createAcpComponent({ pluginRegistry }), { logger });
