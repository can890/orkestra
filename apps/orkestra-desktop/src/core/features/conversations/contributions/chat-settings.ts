import { z } from 'zod';
import {
  DEFAULT_CONTEXT_HANDOFF_THRESHOLD,
  MAX_CONTEXT_HANDOFF_THRESHOLD,
  MIN_CONTEXT_HANDOFF_THRESHOLD,
} from '@core/features/conversations/api/context-handoff-policy';
import type { ChatSettings } from '@core/primitives/app-settings/api';
import { defineSettingsContribution } from '@core/primitives/settings/api';

const chatSettingsSchema = z.object({
  workingTurnSubmitMode: z.enum(['queue', 'steer-cancel']).default('steer-cancel'),
  showContextCompactionBanner: z.boolean().default(true),
  cacheExpiryWarningMinutes: z.number().int().min(1).max(30).default(4),
  contextHandoffSuggestion: z.boolean().default(true),
  contextHandoffThreshold: z
    .number()
    .int()
    .min(MIN_CONTEXT_HANDOFF_THRESHOLD)
    .max(MAX_CONTEXT_HANDOFF_THRESHOLD)
    .default(DEFAULT_CONTEXT_HANDOFF_THRESHOLD),
});

export const chatSettingsContribution = defineSettingsContribution<'chat', ChatSettings>({
  key: 'chat',
  schema: chatSettingsSchema,
  defaults: {
    workingTurnSubmitMode: 'steer-cancel',
    showContextCompactionBanner: true,
    cacheExpiryWarningMinutes: 4,
    contextHandoffSuggestion: true,
    contextHandoffThreshold: DEFAULT_CONTEXT_HANDOFF_THRESHOLD,
  },
});
