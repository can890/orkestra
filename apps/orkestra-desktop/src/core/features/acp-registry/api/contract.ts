import { defineContract, fallible } from '@orkestra/wire/rpc';
import { z } from 'zod';
import {
  acpRegistryErrorSchema,
  addLocalAgentInputSchema,
  customAgentViewSchema,
  registryInstallPlanSchema,
  registrySearchResultSchema,
} from './schemas';

export const acpRegistryDomain = 'acpRegistry' as const;

const providerRefSchema = z.object({ providerId: z.string() });

export const acpRegistryContract = defineContract({
  /** Resmî ACP Registry dizininde arama (kısa zaman aşımlı GET, çevrimdışı önbellek). */
  search: fallible({
    input: z.object({ query: z.string().max(200), refresh: z.boolean().optional() }),
    data: registrySearchResultSchema,
    error: acpRegistryErrorSchema,
  }),
  /** Kayıt ikonunu (yalnızca resmî CDN'den, boyut sınırlı) data URI olarak döndürür. */
  icon: fallible({
    input: z.object({ agentId: z.string() }),
    data: z.object({ dataUri: z.string().nullable() }),
    error: acpRegistryErrorSchema,
  }),
  /** Kurulum planı: neyin indirileceği/çalıştırılacağı; hiçbir şey kurmaz. */
  previewRegistryAgent: fallible({
    input: z.object({ agentId: z.string(), replacesProviderId: z.string().optional() }),
    data: registryInstallPlanSchema,
    error: acpRegistryErrorSchema,
  }),
  /** Kullanıcının onayladığı planı (özetle eşleşmeli) kurar ve ajanı kaydeder; ajanı çalıştırmaz. */
  addRegistryAgent: fallible({
    input: z.object({
      agentId: z.string(),
      version: z.string(),
      digest: z.string(),
      replacesProviderId: z.string().optional(),
    }),
    data: customAgentViewSchema,
    error: acpRegistryErrorSchema,
  }),
  addLocalAgent: fallible({
    input: addLocalAgentInputSchema,
    data: customAgentViewSchema,
    error: acpRegistryErrorSchema,
  }),
  list: fallible({
    input: z.void(),
    data: z.array(customAgentViewSchema),
    error: acpRegistryErrorSchema,
  }),
  /** ACP initialize el sıkışması (+ mümkünse oturum açılışı) ile yetenekleri okur. */
  probe: fallible({
    input: providerRefSchema,
    data: customAgentViewSchema,
    error: acpRegistryErrorSchema,
  }),
  remove: fallible({
    input: providerRefSchema,
    error: acpRegistryErrorSchema,
  }),
  /** Ajanın bildirdiği ortam değişkeni anahtarını sır deposuna yazar (null: siler). */
  setEnvSecret: fallible({
    input: providerRefSchema.extend({ name: z.string(), value: z.string().max(8_192).nullable() }),
    error: acpRegistryErrorSchema,
  }),
});

export type AcpRegistryContract = typeof acpRegistryContract;
