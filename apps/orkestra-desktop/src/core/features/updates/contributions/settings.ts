import { z } from 'zod';
import { defineSettingsContribution } from '@core/primitives/settings/api';

export type UpdateSettings = {
  /** Yeni sürüm bulununca uygulama içinde arka planda indirilsin mi. */
  autoDownload: boolean;
};

const updateSettingsSchema = z.object({
  autoDownload: z.boolean(),
});

export const updateSettingsContribution = defineSettingsContribution<'updates', UpdateSettings>({
  key: 'updates',
  schema: updateSettingsSchema,
  defaults: {
    autoDownload: true,
  },
});
