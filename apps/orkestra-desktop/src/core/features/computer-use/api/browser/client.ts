import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { computerUseContract, computerUseDomain } from '../contract';

export type ComputerUseClient = ContractClient<typeof computerUseContract>;

export function getComputerUseClient(): Promise<ComputerUseClient> {
  return domainClient<ComputerUseClient>(computerUseDomain, computerUseContract);
}
