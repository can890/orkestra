import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { mcpAppsContract, mcpAppsDomain } from '../contract';

export type McpAppsClient = ContractClient<typeof mcpAppsContract>;

export function getMcpAppsClient(): Promise<McpAppsClient> {
  return domainClient<McpAppsClient>(mcpAppsDomain, mcpAppsContract);
}
