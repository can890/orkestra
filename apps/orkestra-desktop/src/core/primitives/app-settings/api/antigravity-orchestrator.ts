import type {
  AntigravityOrchestratorMode,
  ProviderCustomConfig,
  ProviderOrchestratorConfig,
  ProviderProfileConfig,
} from './app-settings';

export type AntigravityOrchestratorEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface AntigravityOrchestratorModeOption {
  id: AntigravityOrchestratorMode;
  label: string;
  description: string;
}

export interface AntigravityRoleModelFamily {
  id: string;
  label: string;
  efforts: readonly AntigravityOrchestratorEffort[];
  defaultEffort: AntigravityOrchestratorEffort;
}

export const ANTIGRAVITY_ORCHESTRATOR_ENV_KEYS = {
  mode: 'ORKESTRA_AGY_ORCHESTRATOR_MODE',
  planner: 'ORKESTRA_AGY_ORCHESTRATOR_PLANNER',
  executor: 'ORKESTRA_AGY_ORCHESTRATOR_EXECUTOR',
} as const;

export const ANTIGRAVITY_EFFORT_LABELS: Record<AntigravityOrchestratorEffort, string> = {
  low: 'Düşük',
  medium: 'Orta',
  high: 'Yüksek',
  xhigh: 'Çok Yüksek',
};

export const ANTIGRAVITY_ORCHESTRATOR_MODES: readonly AntigravityOrchestratorModeOption[] = [
  {
    id: 'standard',
    label: 'Standart (Tek model)',
    description: 'Yeni oturumlar normal tek modelle başlar; sohbet içinde Orkestratör seçilebilir.',
  },
  {
    id: 'gemini-pro-orchestrator-neon',
    label: 'Orchestrator (Neon)',
    description: 'Yeni oturumları Antigravity Orchestrator (Neon) kipinde başlatır.',
  },
  {
    id: 'gemini-pro-orchestrator',
    label: 'Orchestrator (Carbon)',
    description: 'Yeni oturumları Antigravity Orchestrator (Carbon) kipinde başlatır.',
  },
  {
    id: 'gemini-pro-orchestrator-argon',
    label: 'Orchestrator (Argon)',
    description: 'Yeni oturumları Antigravity Orchestrator (Argon) kipinde başlatır.',
  },
] as const;

/** Antigravity CLI `orchestrator-model-roles.orchestrators` ile uyumlu Planlayıcı modelleri. */
export const ANTIGRAVITY_PLANNER_FAMILIES: readonly AntigravityRoleModelFamily[] = [
  {
    id: 'gemini-4-neon',
    label: 'Gemini 4 Neon',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
  {
    id: 'gemini-4-carbon',
    label: 'Gemini 4 Carbon',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
  },
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
  },
] as const;

/** Antigravity CLI `orchestrator-model-roles.executors` ile uyumlu Uygulayıcı modelleri. */
export const ANTIGRAVITY_EXECUTOR_FAMILIES: readonly AntigravityRoleModelFamily[] = [
  {
    id: 'gemini-4-hydrogen',
    label: 'Gemini 4 Hydrogen',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
  },
] as const;

const ORCHESTRATOR_PRESET_IDS = new Set<string>([
  'gemini-pro-orchestrator-neon',
  'gemini-pro-orchestrator',
  'gemini-pro-orchestrator-argon',
]);

export function parseAntigravityRoleSlug(
  slug: string | undefined,
  families: readonly AntigravityRoleModelFamily[]
): { familyId: string; effort: AntigravityOrchestratorEffort } | null {
  const trimmed = slug?.trim();
  if (!trimmed) return null;
  for (const family of families) {
    const prefix = `${family.id}-`;
    if (trimmed.startsWith(prefix)) {
      const suffix = trimmed.slice(prefix.length) as AntigravityOrchestratorEffort;
      if (family.efforts.includes(suffix)) {
        return { familyId: family.id, effort: suffix };
      }
    }
  }
  return null;
}

export function buildAntigravityRoleSlug(
  familyId: string,
  effort: AntigravityOrchestratorEffort,
  families: readonly AntigravityRoleModelFamily[]
): string | undefined {
  const family = families.find((item) => item.id === familyId);
  if (!family) return undefined;
  const resolvedEffort = family.efforts.includes(effort) ? effort : family.defaultEffort;
  return `${family.id}-${resolvedEffort}`;
}

export function normalizeProviderOrchestratorConfig(
  config: ProviderOrchestratorConfig | undefined
): ProviderOrchestratorConfig | undefined {
  if (!config) return undefined;
  const defaultMode =
    config.defaultMode && ORCHESTRATOR_PRESET_IDS.has(config.defaultMode)
      ? config.defaultMode
      : undefined;
  const plannerModel = config.plannerModel?.trim() || undefined;
  const executorModel = config.executorModel?.trim() || undefined;
  if (!defaultMode && !plannerModel && !executorModel) return undefined;
  return {
    ...(defaultMode ? { defaultMode } : {}),
    ...(plannerModel ? { plannerModel } : {}),
    ...(executorModel ? { executorModel } : {}),
  };
}

export function hasOrchestratorOverride(config: ProviderOrchestratorConfig | undefined): boolean {
  return normalizeProviderOrchestratorConfig(config) !== undefined;
}

export function resolveActiveProviderProfile(
  config: ProviderCustomConfig | undefined
): ProviderProfileConfig | undefined {
  if (!config?.activeProfileId || !config.profiles?.length) return undefined;
  return config.profiles.find((profile) => profile.id === config.activeProfileId);
}

export function resolveProviderExtraArgs(
  config: ProviderCustomConfig | undefined
): string | undefined {
  const activeProfile = resolveActiveProviderProfile(config);
  const parts = [config?.extraArgs?.trim(), activeProfile?.extraArgs?.trim()].filter(
    (part): part is string => Boolean(part)
  );
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Antigravity Orkestratör ayarlarını ve aktif profil ortam değişkenlerini birleştirir.
 * Aktif profil `env` değerleri baz ayarların, manuel `config.env` ise Orkestratörün önüne geçer.
 */
export function resolveProviderRuntimeEnv(
  providerId: string,
  config: ProviderCustomConfig | undefined
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  if (providerId === 'antigravity') {
    const normalized = normalizeProviderOrchestratorConfig(config?.orchestrator);
    if (normalized?.defaultMode) {
      merged[ANTIGRAVITY_ORCHESTRATOR_ENV_KEYS.mode] = normalized.defaultMode;
    }
    if (normalized?.plannerModel) {
      merged[ANTIGRAVITY_ORCHESTRATOR_ENV_KEYS.planner] = normalized.plannerModel;
    }
    if (normalized?.executorModel) {
      merged[ANTIGRAVITY_ORCHESTRATOR_ENV_KEYS.executor] = normalized.executorModel;
    }
  }
  if (config?.env) {
    Object.assign(merged, config.env);
  }
  const activeProfile = resolveActiveProviderProfile(config);
  if (activeProfile?.env) {
    Object.assign(merged, activeProfile.env);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function formatAntigravityRoleLabel(
  slug: string | undefined,
  families: readonly AntigravityRoleModelFamily[]
): string {
  const parsed = parseAntigravityRoleSlug(slug, families);
  if (!parsed) return slug?.trim() || 'Antigravity varsayılanı';
  const family = families.find((item) => item.id === parsed.familyId);
  return `${family?.label ?? parsed.familyId} (${ANTIGRAVITY_EFFORT_LABELS[parsed.effort]})`;
}
