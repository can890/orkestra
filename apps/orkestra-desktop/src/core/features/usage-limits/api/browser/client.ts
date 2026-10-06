import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { usageLimitsContract, usageLimitsDomain } from '../usage-limits';

export type UsageLimitsClient = ContractClient<typeof usageLimitsContract>;

export function getUsageLimitsClient(): Promise<UsageLimitsClient> {
  return domainClient<UsageLimitsClient>(usageLimitsDomain, usageLimitsContract);
}
