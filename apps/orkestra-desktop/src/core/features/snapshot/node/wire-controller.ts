import { createController, type Controller } from '@orkestra/wire/rpc';
import { snapshotContract } from '../api/contract';
import type { SnapshotService } from './snapshot-service';

export function createSnapshotWireController(service: SnapshotService): Controller {
  return createController(snapshotContract, {
    getStatus: () => service.getStatus(),
    captureNow: () => service.captureNow(),
    events: service.eventHost,
  });
}
