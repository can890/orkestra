import { z } from 'zod';

export const pluginPacksErrorSchema = z.object({
  type: z.literal('plugin-packs'),
  message: z.string(),
});
export type PluginPacksError = z.infer<typeof pluginPacksErrorSchema>;

export const marketplaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string(),
  url: z.string(),
  addedAt: z.number(),
});
export type Marketplace = z.infer<typeof marketplaceSchema>;

export const marketplacePluginSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  /** Kurulabilir değilse nedeni (ör. harici kaynak). */
  unavailableReason: z.string().optional(),
  installed: z.boolean(),
});
export type MarketplacePlugin = z.infer<typeof marketplacePluginSchema>;

export const previewMcpServerSchema = z.object({
  /** Agent yapılandırmalarına yazılacak son ad (eklenti adıyla önekli). */
  name: z.string(),
  sourceName: z.string(),
  transport: z.enum(['stdio', 'http']),
  /** Çalıştırılacak tam komut satırı (stdio) ya da URL (http). */
  commandLine: z.string(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});
export type PreviewMcpServer = z.infer<typeof previewMcpServerSchema>;

export const pluginPreviewSchema = z.object({
  marketplaceId: z.string(),
  plugin: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  skills: z.array(z.object({ installId: z.string(), description: z.string(), bytes: z.number() })),
  commands: z.array(z.object({ name: z.string(), promptId: z.string(), bytes: z.number() })),
  mcpServers: z.array(previewMcpServerSchema),
  /** Çalıştırılmayacak ya da kaydedilmeyecek öğeler (hook, alt ajan, desteklenmeyen MCP...). */
  unsupported: z.array(
    z.object({
      kind: z.enum(['hook', 'agent', 'mcp', 'skill', 'command']),
      label: z.string(),
      detail: z.string().optional(),
    })
  ),
  /** Aynı adlı mevcut kayıtlar; doluysa kurulum engellenir. */
  conflicts: z.array(z.string()),
  /** Bu özetin özeti; kurulum aynı özetle onaylanmalıdır. */
  digest: z.string(),
});
export type PluginPreview = z.infer<typeof pluginPreviewSchema>;

export const installedPluginSummarySchema = z.object({
  marketplaceId: z.string(),
  plugin: z.string(),
  hostKey: z.string(),
  installedAt: z.number(),
  skills: z.array(z.string()),
  mcpServers: z.array(z.string()),
  prompts: z.array(z.string()),
});
export type InstalledPluginSummary = z.infer<typeof installedPluginSummarySchema>;

export const pluginPacksStateSchema = z.object({
  marketplaces: z.array(marketplaceSchema),
  installs: z.array(installedPluginSummarySchema),
});
export type PluginPacksState = z.infer<typeof pluginPacksStateSchema>;

export const uninstallResultSchema = z.object({
  removed: z.array(z.string()),
  /** Kullanıcı sonradan değiştirdiği için dokunulmayan kayıtlar. */
  kept: z.array(z.string()),
});
export type UninstallResult = z.infer<typeof uninstallResultSchema>;
