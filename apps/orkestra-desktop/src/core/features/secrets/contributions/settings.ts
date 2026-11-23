import { z } from 'zod';
import type { SecretsSettings } from '@core/primitives/app-settings/api';
import { defineSettingsContribution } from '@core/primitives/settings/api';

const secretsSettingsSchema = z.object({
  onePasswordEnabled: z.boolean().default(false),
  onePasswordAccount: z.string().default(''),
  redactTranscriptSecrets: z.boolean().default(true),
});

export const secretsSettingsContribution = defineSettingsContribution<'secrets', SecretsSettings>({
  key: 'secrets',
  schema: secretsSettingsSchema,
  defaults: {
    onePasswordEnabled: false,
    onePasswordAccount: '',
    redactTranscriptSecrets: true,
  },
});
