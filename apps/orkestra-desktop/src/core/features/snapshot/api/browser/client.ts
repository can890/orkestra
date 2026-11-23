import type { ContractClient } from '@orkestra/wire/rpc';
import { snapshotContract, snapshotDomain } from '@core/features/snapshot/api/contract';
import { domainClient } from '@core/primitives/wire/browser/connection';

export type SnapshotClient = ContractClient<typeof snapshotContract>;

export function getSnapshotClient(): Promise<SnapshotClient> {
  return domainClient<SnapshotClient>(snapshotDomain, snapshotContract);
}
