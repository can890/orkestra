import { domainClient } from '@core/primitives/wire/browser/connection';
import type { ContractClient } from '@orkestra/wire/rpc';
import { artifactSharesContract, artifactSharesDomain } from '../contract';

export type ArtifactSharesClient = ContractClient<typeof artifactSharesContract>;

export function getArtifactSharesClient(): Promise<ArtifactSharesClient> {
  return domainClient<ArtifactSharesClient>(artifactSharesDomain, artifactSharesContract);
}
