import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { updatesContract, updatesDomain } from '../contract';

export type UpdatesClient = ContractClient<typeof updatesContract>;

export function getUpdatesClient(): Promise<UpdatesClient> {
  return domainClient<UpdatesClient>(updatesDomain, updatesContract);
}
