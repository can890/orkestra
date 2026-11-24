import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { outsideAgentsContract, outsideAgentsDomain } from '../contract';

export type OutsideAgentsClient = ContractClient<typeof outsideAgentsContract>;

export function getOutsideAgentsClient(): Promise<OutsideAgentsClient> {
  return domainClient<OutsideAgentsClient>(outsideAgentsDomain, outsideAgentsContract);
}
