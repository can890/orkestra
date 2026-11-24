import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { managedPolicyContract, managedPolicyDomain } from '../contract';

export type ManagedPolicyClient = ContractClient<typeof managedPolicyContract>;

export function getManagedPolicyClient(): Promise<ManagedPolicyClient> {
  return domainClient<ManagedPolicyClient>(managedPolicyDomain, managedPolicyContract);
}
