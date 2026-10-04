import { createTuiAgentsComponent } from '@orkestra/core/runtimes/tui-agents/node';
import { pluginRegistry } from '@orkestra/plugins/agents';
import { runWireComponentWorker } from '@orkestra/wire/worker';
import { initWorkerProcessLogging } from '@orkestra/wire/worker/node';

const logger = initWorkerProcessLogging('tui-agents-runtime');
void runWireComponentWorker(createTuiAgentsComponent({ pluginRegistry }), { logger });
