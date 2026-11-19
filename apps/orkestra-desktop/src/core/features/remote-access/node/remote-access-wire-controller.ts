import { createController, type Controller } from '@orkestra/wire/rpc';
import { remoteAccessContract } from '../api/contract';
import type { RemoteAccessService } from './remote-access-service';

export type RemoteAccessOperations = Pick<
  RemoteAccessService,
  | 'getState'
  | 'setEnabled'
  | 'createPairing'
  | 'cancelPairing'
  | 'revokeDevice'
  | 'getAccountPairingState'
  | 'setAccountPairingEnabled'
  | 'checkAccountPairingNow'
>;

/** Yalnızca yerel renderer'ın ayar sayfası içindir; uzak yüzeye açılmaz. */
export function createRemoteAccessWireController(service: RemoteAccessOperations): Controller {
  return createController(remoteAccessContract, {
    getState: () => service.getState(),
    setEnabled: ({ enabled }) => service.setEnabled(enabled),
    createPairing: () => service.createPairing(),
    cancelPairing: ({ deviceId }) => service.cancelPairing(deviceId),
    revokeDevice: ({ deviceId }) => service.revokeDevice(deviceId),
    getAccountPairingState: () => service.getAccountPairingState(),
    setAccountPairingEnabled: ({ enabled }) => service.setAccountPairingEnabled(enabled),
    checkAccountPairingNow: () => service.checkAccountPairingNow(),
  });
}
