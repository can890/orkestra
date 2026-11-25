import { z } from 'zod';
import type {
  ProviderCustomConfig,
  ProviderProfileConfig,
} from '@core/primitives/app-settings/api';

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

const providerProfileConfigSchema: z.ZodType<ProviderProfileConfig> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  extraArgs: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const providerCustomConfigEntrySchema: z.ZodType<ProviderCustomConfig> = z.object({
  extraArgs: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  orchestrator: providerOrchestratorConfigSchema.optional(),
  activeProfileId: z.string().optional(),
  profiles: z.array(providerProfileConfigSchema).optional(),
});

export const providerConfigDefaults: Record<string, ProviderCustomConfig> = {};
