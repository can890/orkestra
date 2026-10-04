import { hostRefSchema } from '@orkestra/core/primitives/host/api';
import {
  agentConfigContract,
  agentConfigMcpErrorSchema,
  mcpServerListSchema,
} from '@orkestra/core/runtimes/agent-config/api';
import { runtimeResolveErrorSchema } from '@orkestra/core/services/runtime-broker/api';
import { defineContract, fallible, liveModel, liveState, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';
import { mcpConnectionStateSchema } from './connection';

const hostInputSchema = z.object({ host: hostRefSchema });
const providerInputSchema = hostInputSchema.extend({ providerId: z.string() });
const mcpErrorSchema = z.union([agentConfigMcpErrorSchema, runtimeResolveErrorSchema]);

export const mcpDomain = 'mcp' as const;

export const mcpContract = defineContract({
  servers: liveModel({
    key: hostInputSchema,
    states: {
      list: liveState({ data: mcpServerListSchema }),
    },
  }),
  connect: fallible({
    input: agentConfigContract.saveMcpServer.input.extend(hostInputSchema.shape),
    data: mcpConnectionStateSchema,
    error: mcpErrorSchema,
  }),
  connectionStatus: procedure({
    input: z.object({ id: z.string() }),
    output: mcpConnectionStateSchema,
  }),
  cancelConnection: procedure({
    input: z.object({ id: z.string() }),
    output: z.void(),
  }),
  saveServer: fallible({
    input: agentConfigContract.saveMcpServer.input.extend(hostInputSchema.shape),
    data: z.void(),
    error: mcpErrorSchema,
  }),
  removeServer: fallible({
    input: agentConfigContract.removeMcpServer.input.extend(hostInputSchema.shape),
    data: z.void(),
    error: mcpErrorSchema,
  }),
  removeForAgent: fallible({
    input: agentConfigContract.removeMcpForAgent.input.extend(hostInputSchema.shape),
    data: z.void(),
    error: mcpErrorSchema,
  }),
  listForAgent: fallible({
    input: providerInputSchema,
    data: z.object({ servers: mcpServerListSchema }),
    error: mcpErrorSchema,
  }),
});

export type McpContract = typeof mcpContract;
