import type { HostRef } from '@emdash/core/primitives/host/api';
import { err, type Result } from '@emdash/shared';
import type { LiveModelProvider, LiveSource } from '@emdash/wire/rpc';
import { createController, type CallMeta, type Controller } from '@emdash/wire/rpc';
import { forwardLiveModel } from '@core/services/runtime-clients/node/forward-live-model';
import { mcpContract } from '../api';
import {
  throwMcpRuntimeResolveError,
  type McpHostRuntimesClient as HostRuntimesClient,
  type McpRuntimeBroker,
  type McpRuntimeResolveError as RuntimeResolveError,
} from '../api/runtime-adapter';
import { McpConnectionManager } from './connection-manager';

export type CreateMcpWireControllerOptions = Readonly<{
  runtimes: McpRuntimeBroker;
}>;

export function createMcpWireController(options: CreateMcpWireControllerOptions): Controller {
  const connections = new McpConnectionManager(options.runtimes);
  return createController(mcpContract, {
    connect: (input) => connections.start(input),
    connectionStatus: (input) => connections.status(input.id),
    cancelConnection: (input) => connections.cancel(input.id),
    servers: createServersModelProvider(options.runtimes),
    saveServer: (input, meta) =>
      withAgentConfigResult(options.runtimes, input.host, (client) =>
        client.saveMcpServer(withoutHost(input), callOptions(meta))
      ),
    removeServer: (input, meta) =>
      withAgentConfigResult(options.runtimes, input.host, (client) =>
        client.removeMcpServer(withoutHost(input), callOptions(meta))
      ),
    removeForAgent: (input, meta) =>
      withAgentConfigResult(options.runtimes, input.host, (client) =>
        client.removeMcpForAgent(withoutHost(input), callOptions(meta))
      ),
    listForAgent: (input, meta) =>
      withAgentConfigResult(options.runtimes, input.host, (client) =>
        client.listMcpForAgent(withoutHost(input), callOptions(meta))
      ),
  });
}

function createServersModelProvider(
  runtimes: McpRuntimeBroker
): LiveModelProvider<typeof mcpContract.servers> {
  return forwardLiveModel(mcpContract.servers, (key, name) =>
    resolveRuntimeSource(runtimes, key.host, (runtime) =>
      runtime.agentConfig.mcpServers.state(undefined, name).asLiveSource()
    )
  );
}

async function withAgentConfigResult<T, E>(
  runtimes: McpRuntimeBroker,
  host: HostRef,
  work: (client: HostRuntimesClient['agentConfig']) => Promise<Result<T, E>>
): Promise<Result<T, E | RuntimeResolveError>> {
  const runtime = await runtimes.client(host);
  if (!runtime.success) return err(runtime.error);
  return await work(runtime.data.agentConfig);
}

async function resolveRuntimeSource(
  runtimes: McpRuntimeBroker,
  host: HostRef,
  source: (client: HostRuntimesClient) => LiveSource
): Promise<LiveSource> {
  const runtime = await runtimes.client(host);
  if (!runtime.success) throwMcpRuntimeResolveError(runtime.error);
  return source(runtime.data);
}

function withoutHost<T extends { host: HostRef }>(input: T): Omit<T, 'host'> {
  const { host: _, ...rest } = input;
  return rest;
}

function callOptions(meta: CallMeta): { signal?: AbortSignal } {
  return meta.signal ? { signal: meta.signal } : {};
}
