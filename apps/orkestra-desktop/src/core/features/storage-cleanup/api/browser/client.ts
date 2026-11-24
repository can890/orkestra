import type { ContractClient } from '@orkestra/wire/rpc';
import {
  storageCleanupContract,
  storageCleanupDomain,
} from '@core/features/storage-cleanup/api/contract';
import { domainClient } from '@core/primitives/wire/browser/connection';

export type StorageCleanupClient = ContractClient<typeof storageCleanupContract>;

export function getStorageCleanupClient(): Promise<StorageCleanupClient> {
  return domainClient<StorageCleanupClient>(storageCleanupDomain, storageCleanupContract);
}
