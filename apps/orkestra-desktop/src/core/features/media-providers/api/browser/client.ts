import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { mediaProvidersContract, mediaProvidersDomain } from '../contract';

export type MediaProvidersClient = ContractClient<typeof mediaProvidersContract>;

export function getMediaProvidersClient(): Promise<MediaProvidersClient> {
  return domainClient<MediaProvidersClient>(mediaProvidersDomain, mediaProvidersContract);
}
