import { defineContract, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

export const storageCleanupDomain = 'storageCleanup' as const;

export const storageCategorySchema = z.enum([
  'worktrees',
  'checkoutCache',
  'logs',
  'caches',
  'attachments',
]);
export type StorageCategory = z.infer<typeof storageCategorySchema>;

export const storageUsageSchema = z.object({
  measuredAt: z.number(),
  categories: z.array(
    z.object({
      category: storageCategorySchema,
      /** Disk kullanımı (bayt); ölçülemediyse null. */
      bytes: z.number().nullable(),
      /** Kategoriye dahil klasörler (bilgi amaçlı). */
      paths: z.array(z.string()),
      /** Temizliğin bu kategoriye hiç dokunmadığı durumlar (ör. ileti ekleri). */
      neverRemoved: z.boolean(),
    })
  ),
});
export type StorageUsage = z.infer<typeof storageUsageSchema>;

export const cleanupEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('worktree'),
    outcome: z.enum(['removed', 'would-remove', 'kept', 'failed']),
    reason: z.string(),
    path: z.string(),
    workspaceId: z.string(),
    projectId: z.string(),
    projectName: z.string(),
    taskIds: z.array(z.string()),
    taskName: z.string().nullable(),
    bytes: z.number().nullable(),
  }),
  z.object({
    kind: z.literal('files'),
    category: storageCategorySchema,
    outcome: z.enum(['removed', 'would-remove', 'kept', 'failed']),
    reason: z.string(),
    files: z.number(),
    bytes: z.number(),
  }),
]);
export type CleanupEntry = z.infer<typeof cleanupEntrySchema>;

export const cleanupReportSchema = z.object({
  trigger: z.enum(['startup', 'settings', 'hourly', 'manual', 'preview']),
  dryRun: z.boolean(),
  startedAt: z.number(),
  finishedAt: z.number(),
  entries: z.array(cleanupEntrySchema),
  /** Kaldırılan (ya da kuru çalıştırmada kaldırılacak) toplam bayt. */
  bytes: z.number(),
  /** Kaldırılan (ya da kaldırılacak) worktree sayısı. */
  worktrees: z.number(),
});
export type CleanupReport = z.infer<typeof cleanupReportSchema>;

export const cleanedWorktreeSchema = z.object({
  workspaceId: z.string(),
  removedAt: z.number(),
  reason: z.string(),
});
export type CleanedWorktree = z.infer<typeof cleanedWorktreeSchema>;

export const storageCleanupContract = defineContract({
  /** Kategori başına güncel disk kullanımı (isteğe bağlı ölçüm; yavaş olabilir). */
  getUsage: procedure({ input: z.void(), output: storageUsageSchema }),
  /** Kuru çalıştırma: şimdi "Temizle" denirse neyin neden kaldırılacağı. Hiçbir şey silinmez. */
  preview: procedure({ input: z.void(), output: cleanupReportSchema }),
  /** Etkin kuralları hemen uygular (onay arayüzde alınır). */
  runNow: procedure({ input: z.void(), output: cleanupReportSchema }),
  /** En son gerçek çalıştırmanın raporu. */
  getLastReport: procedure({ input: z.void(), output: cleanupReportSchema.nullable() }),
  /** Proje geçersiz kılma seçicisi için projeler. */
  listProjects: procedure({
    input: z.void(),
    output: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
  /** Bir workspace'in worktree'si depolama temizliğiyle kaldırıldıysa ayrıntısı. */
  getCleanedWorktree: procedure({
    input: z.object({ workspaceId: z.string() }),
    output: cleanedWorktreeSchema.nullable(),
  }),
});

export type StorageCleanupContract = typeof storageCleanupContract;
