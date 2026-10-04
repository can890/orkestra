import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { browserContract, browserDomain } from '../contract';

export type BrowserClient = ContractClient<typeof browserContract>;

export function getBrowserClient(): Promise<BrowserClient> {
  return domainClient<BrowserClient>(browserDomain, browserContract);
}
