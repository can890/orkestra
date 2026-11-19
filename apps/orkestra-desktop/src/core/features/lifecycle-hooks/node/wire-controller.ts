import { createController, type Controller } from '@orkestra/wire/rpc';
import { lifecycleHooksContract } from '../api/contract';
import type { LifecycleHooksService } from './lifecycle-hooks-service';

export function createLifecycleHooksWireController(service: LifecycleHooksService): Controller {
  return createController(lifecycleHooksContract, {
    getState: async () => service.state(),
    saveConfig: async (input) => {
      const result = await service.save(input);
      return result.success
        ? { success: true, state: result.snapshot }
        : { success: false, error: result.error };
    },
    listRuns: async () => service.runs(),
    clearRuns: async () => service.clearRuns(),
  });
}
