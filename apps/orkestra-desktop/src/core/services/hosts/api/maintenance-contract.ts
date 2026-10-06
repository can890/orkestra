import { defineContract, liveModel, liveState, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

/**
 * Uzak workspace-server bakımı: sürüm denetimi, boştayken otomatik güncelleme ve makine
 * sağlığı (disk kullanımı, eski sürümlerin temizlenmesi). Sunucu durumu (`hosts.serverStates`)
 * ayrı tutulur; bu model yalnızca bakım bilgisini taşır ve her bağlantı için bağımsızdır.
 */

export const serverActivityKindSchema = z.enum([
  'agent-turn',
  'agent-session',
  'terminal',
  'script',
  'dev-server',
]);

export const serverActivityItemSchema = z.object({
  kind: serverActivityKindSchema,
  id: z.string(),
  label: z.string(),
});

export const serverActivitySchema = z.object({
  checkedAt: z.number(),
  items: z.array(serverActivityItemSchema),
  /** Bir çalışma zamanı okunamadığında false olur; eksik okuma hiçbir zaman boşta sayılmaz. */
  complete: z.boolean(),
});

export const serverVersionRoleSchema = z.enum([
  'current',
  'running',
  'previous',
  'prunable',
  'kept',
  'unrecognized',
]);

export const serverVersionEntrySchema = z.object({
  name: z.string(),
  bytes: z.number().optional(),
  role: serverVersionRoleSchema,
});

export const hostHealthSchema = z.object({
  checkedAt: z.number(),
  /** ~/.orkestra/workspace-server dizininin bayt cinsinden boyutu. */
  rootBytes: z.number().optional(),
  /** workspace-server kökünün bulunduğu dosya sistemindeki boş alan (bayt). */
  freeBytes: z.number().optional(),
  versions: z.array(serverVersionEntrySchema),
  prunableBytes: z.number(),
  /** Temizlik şu an güvenli değilse (ör. current bağlantısı okunamıyorsa) nedeni. */
  pruneBlockedReason: z.string().optional(),
});

export const hostMaintenanceStatusSchema = z.enum([
  'unknown',
  'checking',
  'up-to-date',
  'update-available',
  'waiting-for-idle',
  'updating',
  'dev-build',
  'failed',
]);

export const hostMaintenanceStateSchema = z.object({
  status: hostMaintenanceStatusSchema,
  runningVersion: z.string().optional(),
  availableVersion: z.string().optional(),
  lastCheckedAt: z.number().optional(),
  daemonStartedAt: z.number().optional(),
  activity: serverActivitySchema.optional(),
  health: hostHealthSchema.optional(),
  healthError: z.string().optional(),
  error: z.string().optional(),
  lastUpdate: z
    .object({
      from: z.string().optional(),
      to: z.string(),
      at: z.number(),
      automatic: z.boolean(),
    })
    .optional(),
  pruning: z.boolean().optional(),
});

const hostMaintenanceRuntimeSchema = z.record(z.string(), hostMaintenanceStateSchema);
const connectionInputSchema = z.object({ connectionId: z.string().min(1) });

export const pruneResultSchema = z.object({
  removed: z.array(z.string()),
  freedBytes: z.number(),
});

export type ServerActivityKind = z.infer<typeof serverActivityKindSchema>;
export type ServerActivityItem = z.infer<typeof serverActivityItemSchema>;
export type ServerActivity = z.infer<typeof serverActivitySchema>;
export type ServerVersionRole = z.infer<typeof serverVersionRoleSchema>;
export type ServerVersionEntry = z.infer<typeof serverVersionEntrySchema>;
export type HostHealth = z.infer<typeof hostHealthSchema>;
export type HostMaintenanceStatus = z.infer<typeof hostMaintenanceStatusSchema>;
export type HostMaintenanceState = z.infer<typeof hostMaintenanceStateSchema>;
export type HostMaintenanceRuntime = z.infer<typeof hostMaintenanceRuntimeSchema>;
export type PruneResult = z.infer<typeof pruneResultSchema>;

export const hostMaintenanceDomain = 'hostMaintenance' as const;

export const hostMaintenanceContract = defineContract({
  states: liveModel({
    key: z.void(),
    states: {
      runtime: liveState({ data: hostMaintenanceRuntimeSchema }),
    },
  }),
  /** Kanal sürümünü, etkinliği ve sağlığı yeniden okur; yalnızca boştayken kendiliğinden günceller. */
  check: procedure({ input: connectionInputSchema, output: z.void() }),
  /** Güncellemenin neyi keseceğini listelemek için taze etkinlik görüntüsü. */
  inspectActivity: procedure({ input: connectionInputSchema, output: serverActivitySchema }),
  /** Kullanıcının onayladığı güncelleme: meşgul olsa bile kanal sürümünü kurar ve yeniden başlatır. */
  updateNow: procedure({ input: connectionInputSchema, output: z.void() }),
  inspectHealth: procedure({ input: connectionInputSchema, output: z.void() }),
  /** current, çalışan ve önceki sürüm dışındaki kurulu sürümleri siler. */
  pruneVersions: procedure({ input: connectionInputSchema, output: pruneResultSchema }),
});
