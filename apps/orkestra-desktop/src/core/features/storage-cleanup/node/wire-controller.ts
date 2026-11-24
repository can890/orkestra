import { createController, type Controller } from '@orkestra/wire/rpc';
import { storageCleanupContract } from '../api/contract';
import type { StorageCleanupService } from './storage-cleanup-service';

export function createStorageCleanupWireController(service: StorageCleanupService): Controller {
  return createController(storageCleanupContract, {
    getUsage: () => service.getUsage(),
    preview: () => service.preview(),
    runNow: () => service.run('manual'),
    getLastReport: () => service.getLastReport(),
    listProjects: () => service.listProjects(),
    getCleanedWorktree: ({ workspaceId }) => service.getCleanedWorktree(workspaceId),
  });
}
