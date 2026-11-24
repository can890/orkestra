import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { projectRepositoriesContract, projectRepositoriesDomain } from '../contract';

export type ProjectRepositoriesClient = ContractClient<typeof projectRepositoriesContract>;

export function getProjectRepositoriesClient(): Promise<ProjectRepositoriesClient> {
  return domainClient<ProjectRepositoriesClient>(
    projectRepositoriesDomain,
    projectRepositoriesContract
  );
}
