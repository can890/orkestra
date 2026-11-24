import { z } from 'zod';

/**
 * Depolama temizliği ayarları (bu makineye özel). Tüm politikalar varsayılan olarak kapalıdır.
 * Gün değerleri `null` iken o kural kapalıdır. Projeler makine kurallarını devralabilir,
 * temizliği kapatabilir ya da kendi worktree kurallarını kullanabilir; günlük ve önbellek
 * saklama süreleri her zaman makine genelidir.
 */

const retentionDays = z.number().int().min(1).max(3650).nullable();
/** Durulmuş/arşivlenmiş görev için 0 = bir sonraki çalıştırmada. */
const settledRetentionDays = z.number().int().min(0).max(3650).nullable();

export const worktreeCleanupRulesSchema = z.object({
  /** Görev N gündür etkinlik görmediyse worktree'yi kaldır. */
  inactiveDays: retentionDays,
  /** Görev N gündür durulmuş (bitti/iptal) ya da arşivliyse kaldır. */
  settledDays: settledRetentionDays,
  /** Dalın kendi commit'leri varsayılan dala birleştiyse kaldır. */
  onMerge: z.boolean(),
  /** Varsayılan dalın ötesinde commit yoksa ve görev durulmuş/arşivliyse kaldır. */
  unchanged: z.boolean(),
});
export type WorktreeCleanupRules = z.infer<typeof worktreeCleanupRulesSchema>;

export const projectCleanupOverrideSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }),
  z.object({ mode: z.literal('custom'), rules: worktreeCleanupRulesSchema }),
]);
export type ProjectCleanupOverride = z.infer<typeof projectCleanupOverrideSchema>;

export const storageCleanupSettingsSchema = z.object({
  worktrees: worktreeCleanupRulesSchema,
  /** Döndürülmüş/eski günlük dosyalarının saklama süresi (etkin günlük her zaman kalır). */
  logsDays: retentionDays,
  /** Uzak medya önbelleği, performans izleri ve hızlı checkout önbelleğinin saklama süresi. */
  cachesDays: retentionDays,
  /** Proje kimliğine göre geçersiz kılmalar; listede olmayan proje makine kurallarını devralır. */
  projectOverrides: z.record(z.string(), projectCleanupOverrideSchema),
});
export type StorageCleanupSettings = z.infer<typeof storageCleanupSettingsSchema>;

export const DISABLED_WORKTREE_RULES: WorktreeCleanupRules = {
  inactiveDays: null,
  settledDays: null,
  onMerge: false,
  unchanged: false,
};

export const DEFAULT_STORAGE_CLEANUP_SETTINGS: StorageCleanupSettings = {
  worktrees: DISABLED_WORKTREE_RULES,
  logsDays: null,
  cachesDays: null,
  projectOverrides: {},
};

export function worktreeRulesEnabled(rules: WorktreeCleanupRules | null): boolean {
  return (
    rules !== null &&
    (rules.inactiveDays !== null || rules.settledDays !== null || rules.onMerge || rules.unchanged)
  );
}

/** Projeye uygulanacak worktree kuralları; null = bu projede worktree temizliği kapalı. */
export function resolveWorktreeRules(
  settings: StorageCleanupSettings,
  projectId: string
): WorktreeCleanupRules | null {
  const override = settings.projectOverrides[projectId];
  if (override?.mode === 'off') return null;
  const rules = override?.mode === 'custom' ? override.rules : settings.worktrees;
  return worktreeRulesEnabled(rules) ? rules : null;
}

/** Herhangi bir politika (makine ya da proje) açık mı. */
export function anyCleanupPolicyEnabled(settings: StorageCleanupSettings): boolean {
  return (
    worktreeRulesEnabled(settings.worktrees) ||
    settings.logsDays !== null ||
    settings.cachesDays !== null ||
    Object.values(settings.projectOverrides).some(
      (override) => override.mode === 'custom' && worktreeRulesEnabled(override.rules)
    )
  );
}
