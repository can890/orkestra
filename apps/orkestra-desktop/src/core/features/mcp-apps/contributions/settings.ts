import { z } from 'zod';
import { defineSettingsContribution } from '@core/primitives/settings/api';

/**
 * MCP sunucularının sohbette gösterdiği etkileşimli uygulamalar (MCP Apps). `enabled` genel
 * anahtardır; `disabledServers` sunucu başına kapatma listesidir (yapılandırmadaki sunucu adları).
 */
export const mcpAppsSettingsContribution = defineSettingsContribution<
  'mcpApps',
  { enabled: boolean; disabledServers: string[] }
>({
  key: 'mcpApps',
  schema: z.object({
    enabled: z.boolean(),
    disabledServers: z.array(z.string().min(1).max(256)).max(500),
  }),
  defaults: { enabled: true, disabledServers: [] },
});
