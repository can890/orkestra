import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { appearanceContract, appearanceDomain } from '../contract';

export type AppearanceClient = ContractClient<typeof appearanceContract>;

export function getAppearanceClient(): Promise<AppearanceClient> {
  return domainClient<AppearanceClient>(appearanceDomain, appearanceContract);
}
