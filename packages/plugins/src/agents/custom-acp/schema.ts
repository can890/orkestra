// Kullanıcının eklediği ACP ajanlarının (ACP Registry'den kurulan veya yerel komut) kalıcı tanımı.
// Bu dosya tek doğruluk kaynağıdır: ana süreç yazar, ACP/agent-config/tui-agents worker'ları okur.
import { z } from 'zod';

/** Kullanıcı ajanlarının sağlayıcı kimlik öneki; yerleşik ajan kimlikleri bu önekle başlamaz. */
export const CUSTOM_ACP_PROVIDER_PREFIX = 'acp-';
/** Worker süreçlerine dosya yolunu taşıyan ortam değişkeni (ana süreç başlangıçta ayarlar). */
export const CUSTOM_ACP_AGENTS_FILE_ENV = 'ORKESTRA_CUSTOM_ACP_AGENTS_FILE';

export const customAcpProviderIdSchema = z
  .string()
  .max(96)
  .regex(/^acp-[a-z0-9][a-z0-9._-]*$/u, 'Invalid custom ACP agent id');

const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'Invalid environment name');
const envRecordSchema = z.record(envNameSchema, z.string().max(4_096));

export const customAcpLaunchSchema = z.object({
  /** Mutlak yol veya PATH üzerindeki çalıştırılabilir adı; kabuk genişletmesi yapılmaz. */
  command: z.string().trim().min(1).max(4_096),
  args: z.array(z.string().max(4_096)).max(64).default([]),
  env: envRecordSchema.default({}),
  /** İsteğe bağlı süreç çalışma dizini (mutlak yol); yoksa çalışma alanı dizini kullanılır. */
  cwd: z.string().max(4_096).optional(),
});
export type CustomAcpLaunch = z.output<typeof customAcpLaunchSchema>;

export const customAcpRegistryOriginSchema = z.object({
  agentId: z.string().max(128),
  /** Kullanıcının onayladığı ve sabitlenen sürüm; güncelleme açık bir kullanıcı eylemidir. */
  version: z.string().max(128),
  distribution: z.enum(['binary', 'npx', 'uvx']),
  packageSpec: z.string().max(256).optional(),
  archiveUrl: z.string().max(2_048).optional(),
  sha256: z.string().max(64).optional(),
  website: z.string().max(2_048).optional(),
  repository: z.string().max(2_048).optional(),
  license: z.string().max(128).optional(),
  /** Orkestra'nın bu ajan için yönettiği kurulum dizini (kaldırırken silinir). */
  installDir: z.string().max(4_096).optional(),
});
export type CustomAcpRegistryOrigin = z.output<typeof customAcpRegistryOriginSchema>;

export const customAcpAuthMethodSchema = z.object({
  id: z.string().max(128),
  name: z.string().max(160),
  description: z.string().max(1_024).optional(),
  /** ACP `authMethods[].type`; yoksa `agent` (ajanın kendi yönettiği giriş). */
  type: z.enum(['agent', 'terminal', 'env_var']),
  args: z.array(z.string().max(1_024)).max(32).optional(),
  env: envRecordSchema.optional(),
  vars: z
    .array(
      z.object({
        name: envNameSchema,
        label: z.string().max(160).optional(),
        optional: z.boolean().optional(),
      })
    )
    .max(16)
    .optional(),
  link: z.string().max(2_048).optional(),
});
export type CustomAcpAuthMethod = z.output<typeof customAcpAuthMethodSchema>;

export const customAcpProbeSchema = z.object({
  probedAt: z.number(),
  protocolVersion: z.number().nullable(),
  agentName: z.string().max(160).optional(),
  agentVersion: z.string().max(128).optional(),
  loadSession: z.boolean(),
  mcp: z.object({ http: z.boolean(), sse: z.boolean() }),
  authMethods: z.array(customAcpAuthMethodSchema).max(16),
  /** Ajanın oturum açılışında bildirdiği modeller (öğrenilmiş model seçenekleri). */
  models: z.array(z.object({ id: z.string().max(512), name: z.string().max(256) })).max(256),
  modes: z.array(z.object({ id: z.string().max(256), name: z.string().max(256) })).max(64),
  /** Oturum açılamadıysa (ör. giriş gerekli) nedeni. */
  sessionError: z.string().max(1_024).optional(),
});
export type CustomAcpProbe = z.output<typeof customAcpProbeSchema>;

export const customAcpAgentSchema = z.object({
  id: customAcpProviderIdSchema,
  source: z.enum(['registry', 'local']),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(1_024).default(''),
  /** `data:image/...` URI; yalnızca <img> ile gösterilir. */
  iconDataUri: z
    .string()
    .max(1_000_000)
    .regex(/^data:image\/(?:svg\+xml|png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u)
    .optional(),
  launch: customAcpLaunchSchema,
  registry: customAcpRegistryOriginSchema.optional(),
  probe: customAcpProbeSchema.optional(),
  addedAt: z.number(),
});
export type CustomAcpAgent = z.output<typeof customAcpAgentSchema>;
export type CustomAcpAgentInput = z.input<typeof customAcpAgentSchema>;

export const customAcpAgentsFileSchema = z.object({
  version: z.literal(1),
  agents: z.array(z.unknown()).max(256),
});

export function isCustomAcpProviderId(id: string): boolean {
  return id.startsWith(CUSTOM_ACP_PROVIDER_PREFIX);
}

/**
 * Dosya içeriğini çözer; tek tek geçersiz kayıtlar atlanır, böylece bozuk bir kayıt diğer
 * ajanları kullanılmaz hale getirmez.
 */
export function parseCustomAcpAgentsFile(text: string): CustomAcpAgent[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const envelope = customAcpAgentsFileSchema.safeParse(raw);
  if (!envelope.success) return [];
  const seen = new Set<string>();
  const agents: CustomAcpAgent[] = [];
  for (const candidate of envelope.data.agents) {
    const parsed = customAcpAgentSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    agents.push(parsed.data);
  }
  return agents;
}

export function serializeCustomAcpAgentsFile(agents: readonly CustomAcpAgent[]): string {
  return `${JSON.stringify({ version: 1, agents }, null, 2)}\n`;
}
