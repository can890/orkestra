import { z } from 'zod';
import { defineSettingsContribution } from '@core/primitives/settings/api';

export type PowerSettings = {
  /** Bir sohbet çalışırken bilgisayarın uykuya geçmesini engeller (ekran yine kapanabilir). */
  keepAwakeWhileWorking: boolean;
};

const powerSettingsSchema = z.object({
  keepAwakeWhileWorking: z.boolean(),
});

export const powerSettingsContribution = defineSettingsContribution<'power', PowerSettings>({
  key: 'power',
  schema: powerSettingsSchema,
  defaults: {
    keepAwakeWhileWorking: false,
  },
});
