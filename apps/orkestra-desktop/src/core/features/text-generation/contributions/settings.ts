import { z } from 'zod';
import type { TextGenerationSettings } from '@core/primitives/app-settings/api';
import { defineSettingsContribution } from '@core/primitives/settings/api';

const textGenerationSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['openai-compatible', 'anthropic']).default('openai-compatible'),
  baseUrl: z.string().default('https://api.openai.com/v1'),
  model: z.string().default('gpt-4o-mini'),
  autoTitleTasks: z.boolean().default(true),
  promptSuggestionsEnabled: z.boolean().default(true),
});

export const textGenerationSettingsContribution = defineSettingsContribution<
  'textGeneration',
  TextGenerationSettings
>({
  key: 'textGeneration',
  schema: textGenerationSettingsSchema,
  defaults: {
    enabled: false,
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    autoTitleTasks: true,
    promptSuggestionsEnabled: true,
  },
});
