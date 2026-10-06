import { hostRef } from '@orkestra/core/primitives/host/api';
import { createController, type Controller } from '@orkestra/wire/rpc';
import { hostMaintenanceContract } from '../api/maintenance-contract';
import type { Hosts } from './hosts';

/** `hostMaintenance` alanının denetleyicisi; her istek ilgili makinenin bakım nesnesine gider. */
export function createHostMaintenanceWireController(
  hosts: Pick<Hosts, 'get' | 'maintenanceModel'>
): Controller {
  const maintenance = (id: string) => {
    const host = hosts.get(hostRef('remote', id));
    if (!host) throw new Error(`Host '${id}' is not managed`);
    return host.maintenance;
  };
  return createController(hostMaintenanceContract, {
    states: hosts.maintenanceModel.host,
    check: ({ connectionId }) => maintenance(connectionId).check(),
    inspectActivity: ({ connectionId }) => maintenance(connectionId).inspectActivity(),
    updateNow: ({ connectionId }) => maintenance(connectionId).updateNow(),
    inspectHealth: ({ connectionId }) => maintenance(connectionId).inspectHealth(),
    pruneVersions: ({ connectionId }) => maintenance(connectionId).prune(),
  });
}
