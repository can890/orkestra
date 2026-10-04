import { createAgentConfigComponent } from '@orkestra/core/runtimes/agent-config/node';
import { pluginRegistry } from '@orkestra/plugins/agents';
import { runWireComponentWorker } from '@orkestra/wire/worker';
import { initWorkerProcessLogging } from '@orkestra/wire/worker/node';

const logger = initWorkerProcessLogging('agent-config-runtime');
void runWireComponentWorker(createAgentConfigComponent({ pluginRegistry }), { logger });
