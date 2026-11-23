import { z } from 'zod';
import type { ProviderCustomConfig } from '@core/primitives/app-settings/api';

const providerOrchestratorConfigSchema = z.object({
  defaultMode: z
    .enum([
      'standard',
      'gemini-pro-orchestrator-neon',
      'gemini-pro-orchestrator',
      'gemini-pro-orchestrator-argon',
    ])
    .optional(),
  plannerModel: z.string().optional(),
  executorModel: z.string().optional(),
});

export const providerCustomConfigEntrySchema: z.ZodType<ProviderCustomConfig> = z.object({
  extraArgs: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  orchestrator: providerOrchestratorConfigSchema.optional(),
});

export const providerConfigDefaults: Record<string, ProviderCustomConfig> = {};
