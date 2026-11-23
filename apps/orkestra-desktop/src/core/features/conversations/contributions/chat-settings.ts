import { z } from 'zod';
import type { ChatSettings } from '@core/primitives/app-settings/api';
import { defineSettingsContribution } from '@core/primitives/settings/api';

const chatSettingsSchema = z.object({
  workingTurnSubmitMode: z.enum(['queue', 'steer-cancel']).default('queue'),
  showContextCompactionBanner: z.boolean().default(true),
  cacheExpiryWarningMinutes: z.number().int().min(1).max(30).default(4),
});

export const chatSettingsContribution = defineSettingsContribution<'chat', ChatSettings>({
  key: 'chat',
  schema: chatSettingsSchema,
  defaults: {
    workingTurnSubmitMode: 'queue',
    showContextCompactionBanner: true,
    cacheExpiryWarningMinutes: 4,
  },
});
