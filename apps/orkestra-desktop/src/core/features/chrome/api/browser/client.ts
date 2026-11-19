import type { ContractClient } from '@orkestra/wire/rpc';
import { chromeContract, chromeDomain } from '@core/features/chrome/api/contract';
import { domainClient } from '@core/primitives/wire/browser/connection';

export type ChromeClient = ContractClient<typeof chromeContract>;

export function getChromeClient(): Promise<ChromeClient> {
  return domainClient<ChromeClient>(chromeDomain, chromeContract);
}
