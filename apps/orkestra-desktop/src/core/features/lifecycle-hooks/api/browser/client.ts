import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { lifecycleHooksContract, lifecycleHooksDomain } from '../contract';

export type LifecycleHooksClient = ContractClient<typeof lifecycleHooksContract>;

export function getLifecycleHooksClient(): Promise<LifecycleHooksClient> {
  return domainClient<LifecycleHooksClient>(lifecycleHooksDomain, lifecycleHooksContract);
}
