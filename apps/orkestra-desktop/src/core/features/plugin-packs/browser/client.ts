import type { ContractClient } from '@orkestra/wire/rpc';
import { pluginPacksContract, pluginPacksDomain } from '@core/features/plugin-packs/api/contract';
import { domainClient } from '@core/primitives/wire/browser/connection';

export type PluginPacksRpcClient = ContractClient<typeof pluginPacksContract>;

export function getPluginPacksClient(): Promise<PluginPacksRpcClient> {
  return domainClient<PluginPacksRpcClient>(pluginPacksDomain, pluginPacksContract);
}
