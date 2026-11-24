// ACP Registry / yerel ACP komutu özelliğinin renderer'a giden tel şemaları.
import { z } from 'zod';

export const acpRegistryErrorSchema = z.object({
  type: z.literal('acp-registry'),
  reason: z.enum([
    'registry_unavailable',
    'agent_not_found',
    'unsupported_platform',
    'unsupported_distribution',
    'runner_unavailable',
    'download_failed',
    'checksum_mismatch',
    'archive_invalid',
    'install_failed',
    'plan_changed',
    'invalid_input',
    'not_found',
    'probe_failed',
    'io',
  ]),
  message: z.string(),
});
export type AcpRegistryError = z.infer<typeof acpRegistryErrorSchema>;
export type AcpRegistryErrorReason = AcpRegistryError['reason'];

export const distributionKindSchema = z.enum(['binary', 'npx', 'uvx']);

export const registrySearchAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  authors: z.array(z.string()),
  license: z.string().nullable(),
  website: z.string().nullable(),
  repository: z.string().nullable(),
  hasIcon: z.boolean(),
  distribution: distributionKindSchema,
  /** `sha256`: ikili kayıtta sağlama toplamı var; `registry`: yalnızca HTTPS dağıtım güvencesi. */
  integrity: z.enum(['sha256', 'registry']),
  /** Paket dağıtımı için gereken yönetici (npm/uv) ve bu makinede bulunup bulunmadığı. */
  runner: z.enum(['npm', 'uv']).nullable(),
  runnerAvailable: z.boolean(),
  /** Orkestra'nın birinci sınıf desteklediği ajan (ikinci kez eklenemez). */
  builtInProviderId: z.string().nullable(),
  /** Zaten eklenmişse kullanıcı ajanının sağlayıcı kimliği ve sabitlenen sürümü. */
  added: z.object({ providerId: z.string(), version: z.string() }).nullable(),
});
export type RegistrySearchAgent = z.infer<typeof registrySearchAgentSchema>;

export const registrySearchResultSchema = z.object({
  agents: z.array(registrySearchAgentSchema),
  /** Dizinin ağdan en son başarıyla alındığı zaman (ms). */
  fetchedAt: z.number().nullable(),
  /** Önbellekten sunuldu çünkü ağ isteği başarısız oldu. */
  offline: z.boolean(),
  /** Önbellek eski (ağdan alınamadı veya 24 saatten eski). */
  stale: z.boolean(),
  offlineReason: z.string().nullable(),
  /** Bu makinenin kayıt platform hedefi (ör. darwin-aarch64); desteklenmiyorsa null. */
  platformTarget: z.string().nullable(),
  discarded: z.number(),
});
export type RegistrySearchResult = z.infer<typeof registrySearchResultSchema>;

/** Kullanıcının onaylayacağı kurulum planı: tam olarak ne indirilecek ve ne çalıştırılacak. */
export const registryInstallPlanSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  version: z.string(),
  distribution: distributionKindSchema,
  packageSpec: z.string().nullable(),
  archiveUrl: z.string().nullable(),
  sha256: z.string().nullable(),
  /** Kurulum sırasında çalışacak komut (npm/uv); ikili için null (yalnızca indirme). */
  installCommand: z.array(z.string()).nullable(),
  installDir: z.string(),
  /** Ajanı başlatmak için çalıştırılacak komut satırı (argv). */
  launchCommand: z.array(z.string()),
  launchEnv: z.record(z.string(), z.string()),
  license: z.string().nullable(),
  repository: z.string().nullable(),
  website: z.string().nullable(),
  /** Onaylanan planın özeti; `addRegistryAgent` aynı özeti ister. */
  digest: z.string(),
  replacesProviderId: z.string().nullable(),
});
export type RegistryInstallPlan = z.infer<typeof registryInstallPlanSchema>;

export const customAgentAuthMethodSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.enum(['agent', 'terminal', 'env_var']),
  args: z.array(z.string()),
  vars: z.array(z.object({ name: z.string(), label: z.string(), configured: z.boolean() })),
  link: z.string().nullable(),
});

export const customAgentViewSchema = z.object({
  providerId: z.string(),
  source: z.enum(['registry', 'local']),
  name: z.string(),
  description: z.string(),
  iconDataUri: z.string().nullable(),
  launchCommand: z.array(z.string()),
  launchEnvNames: z.array(z.string()),
  cwd: z.string().nullable(),
  executableAvailable: z.boolean(),
  registry: z
    .object({
      agentId: z.string(),
      version: z.string(),
      distribution: distributionKindSchema,
      packageSpec: z.string().nullable(),
      archiveUrl: z.string().nullable(),
      sha256: z.string().nullable(),
    })
    .nullable(),
  probe: z
    .object({
      probedAt: z.number(),
      protocolVersion: z.number().nullable(),
      agentName: z.string().nullable(),
      agentVersion: z.string().nullable(),
      loadSession: z.boolean(),
      models: z.array(z.object({ id: z.string(), name: z.string() })),
      modes: z.array(z.object({ id: z.string(), name: z.string() })),
      sessionError: z.string().nullable(),
    })
    .nullable(),
  authMethods: z.array(customAgentAuthMethodSchema),
  addedAt: z.number(),
});
export type CustomAgentView = z.infer<typeof customAgentViewSchema>;

export const addLocalAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  command: z.string().trim().min(1).max(4_096),
  args: z.array(z.string().max(4_096)).max(64),
  env: z.record(z.string(), z.string().max(4_096)),
  cwd: z.string().trim().max(4_096).optional(),
});
export type AddLocalAgentInput = z.infer<typeof addLocalAgentInputSchema>;
