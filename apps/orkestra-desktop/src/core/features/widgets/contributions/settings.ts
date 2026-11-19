import { z } from 'zod';
import { defineSettingsContribution } from '@core/primitives/settings/api';

/** Ajanın sohbete satır içi widget koyabilmesi (`orkestra-widgets` MCP sunucusu). */
export const widgetsSettingsContribution = defineSettingsContribution<
  'widgets',
  { enabled: boolean }
>({
  key: 'widgets',
  schema: z.object({ enabled: z.boolean() }),
  defaults: { enabled: true },
});
