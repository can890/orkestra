// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/provider-acp-registry/src/server/AcpRegistrySupport.ts
// Resmî ACP Registry dizininin (registry.json) şeması. Effect Schema yerine zod; davranış aynı:
// zarf doğrulanır, geçersiz tek tek ajan kayıtları atlanır, sürümler kesin olmak zorundadır.
import { z } from 'zod';

export const ACP_REGISTRY_URL =
  'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
/** Kayıt ikonları yalnızca bu kökenden indirilir. */
export const ACP_REGISTRY_ICON_ORIGIN = 'https://cdn.agentclientprotocol.com';
export const ACP_REGISTRY_MAX_AGENTS = 512;
export const MAX_REGISTRY_BYTES = 1024 * 1024;

const boundedAgentId = z
  .string()
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);
const boundedName = z.string().trim().min(1).max(160);
// Sürümler kurulum dizini adı olur; "." ve ".." çözülmemeli.
const boundedVersion = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u);
const boundedDescription = z.string().max(1_024);
const boundedMetadata = z.string().max(256);
const boundedArgument = z.string().max(1_024);

const EXACT_RUNNER_VERSION = 'v?[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?';
const EXACT_NPX_PACKAGE = new RegExp(
  `^(?:@[^/@\\s]+/[^@\\s]+|[a-z0-9][a-z0-9._-]*)@${EXACT_RUNNER_VERSION}$`,
  'iu'
);
const EXACT_UVX_PACKAGE = new RegExp(`^[a-z0-9][a-z0-9._-]*(?:@|==)${EXACT_RUNNER_VERSION}$`, 'iu');

export function isHttpsUrlWithoutCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

const httpsUrl = z
  .string()
  .max(2_048)
  .refine(isHttpsUrlWithoutCredentials, 'ACP Registry URLs must use HTTPS without credentials.');

const packageDistributionFields = {
  args: z.array(boundedArgument).max(64).optional(),
  env: z.record(boundedMetadata, boundedArgument).optional(),
};

export const acpRegistryBinaryTargetSchema = z.object({
  archive: httpsUrl,
  cmd: boundedArgument,
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/iu)
    .optional(),
  args: z.array(boundedArgument).max(64).optional(),
  env: z.record(boundedMetadata, boundedArgument).optional(),
});
export type AcpRegistryBinaryTarget = z.output<typeof acpRegistryBinaryTargetSchema>;

export const acpRegistryAgentSchema = z.object({
  id: boundedAgentId,
  name: boundedName,
  version: boundedVersion,
  description: boundedDescription,
  authors: z.array(boundedMetadata).max(16).optional(),
  license: z.string().max(128).optional(),
  website: httpsUrl.optional(),
  repository: httpsUrl.optional(),
  icon: httpsUrl.optional(),
  distribution: z.object({
    binary: z.record(z.string(), acpRegistryBinaryTargetSchema).optional(),
    npx: z
      .object({
        package: z
          .string()
          .max(256)
          .regex(EXACT_NPX_PACKAGE, 'ACP Registry npx packages must include an exact version.'),
        ...packageDistributionFields,
      })
      .optional(),
    uvx: z
      .object({
        package: z
          .string()
          .max(256)
          .regex(EXACT_UVX_PACKAGE, 'ACP Registry uvx packages must include an exact version.'),
        ...packageDistributionFields,
      })
      .optional(),
  }),
});
export type AcpRegistryAgent = z.output<typeof acpRegistryAgentSchema>;

const registryEnvelopeSchema = z.object({
  version: boundedVersion,
  agents: z.array(z.unknown()).max(ACP_REGISTRY_MAX_AGENTS),
});

export type AcpRegistryIndex = {
  version: string;
  agents: AcpRegistryAgent[];
  /** Şemaya uymadığı için atlanan kayıt sayısı. */
  discarded: number;
};

export class AcpRegistryParseError extends Error {}

/** registry.json metnini çözer; zarf geçersizse hata fırlatır, tek tek bozuk ajanları atlar. */
export function parseAcpRegistryIndex(text: string): AcpRegistryIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AcpRegistryParseError('ACP Registry index is not valid JSON.');
  }
  const envelope = registryEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new AcpRegistryParseError('ACP Registry index has an unexpected shape.');
  }
  const agents: AcpRegistryAgent[] = [];
  const seen = new Set<string>();
  for (const candidate of envelope.data.agents) {
    const parsed = acpRegistryAgentSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    agents.push(parsed.data);
  }
  return {
    version: envelope.data.version,
    agents,
    discarded: envelope.data.agents.length - agents.length,
  };
}

/** Arama sıralaması (T3 `searchRank`); eşleşmezse undefined. Küçük değer daha iyi. */
export function acpRegistrySearchRank(agent: AcpRegistryAgent, query: string): number | undefined {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return 100;
  const id = agent.id.toLowerCase();
  const name = agent.name.toLowerCase();
  const authors = (agent.authors ?? []).join(' ').toLowerCase();
  const description = agent.description.toLowerCase();
  const terms = normalized.split(/\s+/u);
  if (id === normalized || name === normalized) return 0;
  if (id.startsWith(normalized) || name.startsWith(normalized)) return 10;
  const identityTokens = `${id} ${name}`.split(/[^a-z0-9]+/u).filter(Boolean);
  if (terms.every((term) => identityTokens.some((token) => token.startsWith(term)))) return 20;
  if (terms.every((term) => id.includes(term) || name.includes(term))) return 30;
  if (terms.every((term) => authors.includes(term))) return 40;
  if (terms.every((term) => `${id} ${name} ${authors} ${description}`.includes(term))) return 50;
  return undefined;
}
