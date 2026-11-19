import { hostRefSchema } from '@orkestra/core/primitives/host/api';
import { defineContract, fallible } from '@orkestra/wire/rpc';
import { z } from 'zod';
import {
  installedPluginSummarySchema,
  marketplacePluginSchema,
  marketplaceSchema,
  pluginPacksErrorSchema,
  pluginPacksStateSchema,
  pluginPreviewSchema,
  uninstallResultSchema,
} from './schemas';

export const pluginPacksDomain = 'pluginPacks' as const;

const pluginRefSchema = z.object({ marketplaceId: z.string(), plugin: z.string() });
const hostPluginRefSchema = pluginRefSchema.extend({ host: hostRefSchema });

export const pluginPacksContract = defineContract({
  state: fallible({
    input: z.void(),
    data: pluginPacksStateSchema,
    error: pluginPacksErrorSchema,
  }),
  addMarketplace: fallible({
    input: z.object({ source: z.string() }),
    data: marketplaceSchema,
    error: pluginPacksErrorSchema,
  }),
  removeMarketplace: fallible({
    input: z.object({ id: z.string() }),
    error: pluginPacksErrorSchema,
  }),
  listPlugins: fallible({
    input: z.object({ marketplaceId: z.string() }),
    data: z.object({ plugins: z.array(marketplacePluginSchema) }),
    error: pluginPacksErrorSchema,
  }),
  previewPlugin: fallible({
    input: hostPluginRefSchema,
    data: pluginPreviewSchema,
    error: pluginPacksErrorSchema,
  }),
  installPlugin: fallible({
    input: hostPluginRefSchema.extend({
      /** `previewPlugin` çıktısındaki `digest`; kullanıcının onayladığı içerik. */
      digest: z.string(),
      /** MCP sunucularının yazılacağı agent kimlikleri. */
      providers: z.array(z.string()),
    }),
    data: installedPluginSummarySchema,
    error: pluginPacksErrorSchema,
  }),
  uninstallPlugin: fallible({
    input: hostPluginRefSchema,
    data: uninstallResultSchema,
    error: pluginPacksErrorSchema,
  }),
});

export type PluginPacksContract = typeof pluginPacksContract;
