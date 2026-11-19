import { join } from 'node:path';
import { err, type Result } from '@orkestra/shared';
import { createController, type Controller } from '@orkestra/wire/rpc';
import { pluginPacksContract } from '../api';
import type { PluginPacksError } from '../api/schemas';
import { gitClone, type CloneFn } from './git-clone';
import { resolveRuntimeHostTarget } from './host-target';
import { PluginPacksService, type PluginPromptStore } from './plugin-service';
import { ProvenanceStore } from './provenance-store';

export type CreatePluginPacksWireControllerOptions = Readonly<{
  runtimes: Parameters<typeof resolveRuntimeHostTarget>[0];
  prompts: PluginPromptStore;
  /** `app.getPath('userData')` */
  userDataDir: string;
  clone?: CloneFn;
}>;

function toWire<T>(result: Result<T, string>): Result<T, PluginPacksError> {
  return result.success ? result : err({ type: 'plugin-packs', message: result.error });
}

export function createPluginPacksWireController(
  options: CreatePluginPacksWireControllerOptions
): Controller {
  const rootDir = join(options.userDataDir, 'plugin-packs');
  const service = new PluginPacksService({
    rootDir,
    store: new ProvenanceStore(rootDir),
    prompts: options.prompts,
    clone: options.clone ?? gitClone,
    resolveHost: (host) => resolveRuntimeHostTarget(options.runtimes, host),
  });
  return createController(pluginPacksContract, {
    state: async () => toWire(await service.getState()),
    addMarketplace: async ({ source }) => toWire(await service.addMarketplace(source)),
    removeMarketplace: async ({ id }) => toWire(await service.removeMarketplace(id)),
    listPlugins: async ({ marketplaceId }) => toWire(await service.listPlugins(marketplaceId)),
    previewPlugin: async (input) => toWire(await service.previewPlugin(input)),
    installPlugin: async (input) => toWire(await service.installPlugin(input)),
    uninstallPlugin: async (input) => toWire(await service.uninstallPlugin(input)),
  });
}
