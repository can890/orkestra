import { hostRefSchema, type HostRef } from '@orkestra/core/primitives/host/api';
import { defineContract, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

/**
 * Abonelik kullanım pencereleri (Claude 5 saatlik/haftalık, Codex dönem kotaları …). Değerler her
 * makinenin kendi ajan oturumlarından okunur ve ana süreçte önbelleğe alınır; hem kenar çubuğu
 * göstergesi hem ayarlar sayfası hem de Orkestra şefinin yönlendirmesi aynı önbelleği kullanır.
 */

export const usageWindowSchema = z.object({
  label: z.string(),
  /** Pencerenin kullanılan yüzdesi (0–100). */
  usedPercent: z.number().min(0).max(100),
  /** Pencerenin yenileneceği an (ISO). */
  resetsAt: z.string().optional(),
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

export const providerUsageSchema = z.object({
  providerId: z.string(),
  status: z.enum(['available', 'unavailable', 'auth-required', 'error']),
  windows: z.array(usageWindowSchema),
  balances: z.array(z.object({ label: z.string(), value: z.number(), unit: z.string() })),
  plan: z.string().optional(),
  account: z.string().optional(),
  /** Verinin kaynağı (canlı API, yerel önbellek, oturum günlüğü …). */
  source: z.string(),
  message: z.string().optional(),
  /** Ölçümün yapıldığı an (ISO); yerel önbellek ve günlük yedeklerinde eski olabilir. */
  measuredAt: z.string(),
  /** Ana sürecin bu değeri sağlayıcıdan en son aldığı an (epoch ms). */
  fetchedAt: z.number(),
  /** Son yenileme başarısız oldu; gösterilen pencereler önceki başarılı ölçümden. */
  refreshError: z.string().optional(),
});
export type ProviderUsage = z.infer<typeof providerUsageSchema>;

export const usageSnapshotSchema = z.object({ providers: z.array(providerUsageSchema) });
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;

/** Kenar çubuğu göstergesinin izlediği abonelik ajanları. */
export const INDICATOR_USAGE_PROVIDERS = ['claude', 'codex', 'kimi', 'glm', 'grok'] as const;
/** Göstergede veri olmasa da her zaman görünen sağlayıcılar. */
export const PINNED_USAGE_PROVIDERS: readonly string[] = ['claude', 'codex'];

export const usageLimitsDomain = 'usageLimits' as const;

export const usageLimitsContract = defineContract({
  /** Önbellekteki değerler; süresi geçenler (veya `force` ile hepsi) sağlayıcıdan yeniden okunur. */
  get: procedure({
    input: z.object({
      host: hostRefSchema,
      providerIds: z.array(z.string().min(1)).min(1).max(12),
      force: z.boolean().optional(),
    }),
    output: usageSnapshotSchema,
  }),
});

/** Orkestra gibi ana süreç tüketicilerinin ihtiyaç duyduğu salt okunur arayüz. */
export type UsageLimitsReader = {
  /**
   * En fazla `maxWaitMs` bekler; zamanında gelmeyen sağlayıcı için önbellekteki son değer (yoksa
   * null) döner ve sorgu arka planda tamamlanıp önbelleği doldurur.
   */
  peek(
    host: HostRef,
    providerIds: readonly string[],
    maxWaitMs: number
  ): Promise<Record<string, ProviderUsage | null>>;
};
