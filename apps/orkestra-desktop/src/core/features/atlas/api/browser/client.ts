import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { atlasContract, atlasDomain } from '../contract';

export type AtlasClient = ContractClient<typeof atlasContract>;

export function getAtlasClient(): Promise<AtlasClient> {
  return domainClient<AtlasClient>(atlasDomain, atlasContract);
}
