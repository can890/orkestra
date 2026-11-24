import { z } from 'zod';

/**
 * "Limit farkındalıklı alt ajan yönlendirmesi" ayarı. Politika kullanıcı tarafından düzenlenir;
 * katman sırası ucuzdan pahalıya doğrudur (yönlendirme asla daha pahalı katmana çıkmaz).
 * Yapı çekirdekteki `SubagentRoutingPolicy` ile birebir aynıdır.
 */

export const SUBAGENT_PROVIDERS = [
  'antigravity',
  'codex',
  'claude',
  'kimi',
  'grok',
  'gemini',
] as const;

const candidateSchema = z.object({
  provider: z.enum(SUBAGENT_PROVIDERS),
  model: z.string().trim().min(1).max(128),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  enabled: z.boolean(),
});

const tierSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/),
  label: z.string().min(1).max(60),
  enabled: z.boolean(),
  candidates: z.array(candidateSchema).max(20),
});

export const subagentRoutingSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  thresholdPercent: z.number().int().min(1).max(90).default(10),
  avoidParentScarceModels: z.boolean().default(true),
  scarceModels: z.array(z.string().trim().min(1).max(128)).max(20),
  tiers: z.array(tierSchema).max(6),
});

export type SubagentRoutingSettings = z.infer<typeof subagentRoutingSettingsSchema>;
export type SubagentRoutingCandidateSetting = z.infer<typeof candidateSchema>;
export type SubagentRoutingTierSetting = z.infer<typeof tierSchema>;

export const DEFAULT_SUBAGENT_ROUTING_SETTINGS: SubagentRoutingSettings = {
  enabled: false,
  thresholdPercent: 10,
  avoidParentScarceModels: true,
  scarceModels: ['claude-fable-*', 'claude-mythos-*'],
  tiers: [
    {
      id: 'context',
      label: 'Context gathering',
      enabled: true,
      candidates: [
        { provider: 'codex', model: 'gpt-6-luna', effort: 'medium', enabled: true },
        { provider: 'antigravity', model: 'gemini-3.8-flash-medium', enabled: true },
        { provider: 'claude', model: 'claude-haiku-5-5', enabled: true },
        { provider: 'kimi', model: 'kimi-code/k3', enabled: true },
      ],
    },
    {
      id: 'execution',
      label: 'Execution',
      enabled: true,
      candidates: [
        { provider: 'codex', model: 'gpt-6.2-astra', effort: 'high', enabled: true },
        { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', enabled: true },
        { provider: 'antigravity', model: 'gemini-4-hydrogen-medium', enabled: true },
        { provider: 'kimi', model: 'kimi-code/k3.1-pro', enabled: true },
      ],
    },
    {
      id: 'judgment',
      label: 'Judgment',
      enabled: true,
      candidates: [
        { provider: 'claude', model: 'claude-opus-5-5', effort: 'high', enabled: true },
        { provider: 'codex', model: 'gpt-6.2-sol', effort: 'high', enabled: true },
        { provider: 'antigravity', model: 'gemini-4-neon-high', enabled: true },
        { provider: 'claude', model: 'claude-fable-5-2', effort: 'high', enabled: true },
      ],
    },
  ],
};
