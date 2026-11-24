import { createController, type Controller } from '@orkestra/wire/rpc';
import { managedPolicyContract } from '@core/features/managed-policy/api/contract';
import { getActiveManagedPolicy } from '@core/primitives/managed-policy/api/node/active-policy';

/** Açılışta yüklenen politikanın özetini renderer'a verir (salt-okur). */
export function createManagedPolicyWireController(): Controller {
  return createController(managedPolicyContract, {
    getSummary: async () => getActiveManagedPolicy()?.summary ?? null,
  });
}
