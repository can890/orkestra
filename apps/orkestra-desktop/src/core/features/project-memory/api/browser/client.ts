import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { projectMemoryContract, projectMemoryDomain } from '../contract';

export type ProjectMemoryClient = ContractClient<typeof projectMemoryContract>;

export function getProjectMemoryClient(): Promise<ProjectMemoryClient> {
  return domainClient<ProjectMemoryClient>(projectMemoryDomain, projectMemoryContract);
}
