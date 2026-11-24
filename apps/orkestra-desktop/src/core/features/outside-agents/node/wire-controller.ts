import { createController, type Controller } from '@orkestra/wire/rpc';
import { outsideAgentsContract } from '@core/features/outside-agents/api/contract';
import type { OutsideAgentsService } from './outside-agents-service';

export type OutsideAgentsOperations = Pick<
  OutsideAgentsService,
  'getStatus' | 'configure' | 'createClient' | 'setClientAccess' | 'revokeClient'
>;

/** Yalnızca yerel renderer'ın ayar sayfası içindir; uzak (mobil) yüzeye eklenmez. */
export function createOutsideAgentsWireController(service: OutsideAgentsOperations): Controller {
  return createController(outsideAgentsContract, {
    getStatus: () => service.getStatus(),
    configure: (patch) => service.configure(patch),
    createClient: ({ name, access }) => service.createClient(name, access),
    setClientAccess: ({ id, access }) => service.setClientAccess(id, access),
    revokeClient: ({ id }) => service.revokeClient(id),
  });
}
