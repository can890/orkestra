import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { subagentRoutingContract, subagentRoutingDomain } from '../contract';

export type SubagentRoutingClient = ContractClient<typeof subagentRoutingContract>;

export function getSubagentRoutingClient(): Promise<SubagentRoutingClient> {
  return domainClient<SubagentRoutingClient>(subagentRoutingDomain, subagentRoutingContract);
}
