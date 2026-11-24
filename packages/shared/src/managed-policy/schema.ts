// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/contracts/src/managedPolicy.ts
//
// Yöneticinin makine genelinde dağıttığı politika dosyasının şeması. Bilinmeyen anahtarlar
// reddedilir: bu sürümün uygulayamadığı bir kısıtlama "yönetiliyor" gibi görünüp
// uygulanmamış olmamalıdır (fail-closed).
import { z } from 'zod';

/** Desteklenen tek şema sürümü. Daha yeni bir sürüm, bu derlemenin bilmediği kurallar taşır. */
export const MANAGED_POLICY_SCHEMA_VERSION = 1;

/**
 * Orkestra izin modları, en dardan en genişe. `plan` hiçbir şeyi değiştirmez; `bypass`
 * tüm izin onaylarını atlar.
 */
export const PERMISSION_MODES = ['plan', 'default', 'acceptEdits', 'auto', 'bypass'] as const;
export type ManagedPermissionMode = (typeof PERMISSION_MODES)[number];
export const permissionModeSchema = z.enum(PERMISSION_MODES);

export const PERMISSION_MODE_LABELS: Record<ManagedPermissionMode, string> = {
  plan: 'Plan',
  default: 'Manual',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  bypass: 'Skip permissions',
};

const trimmedNonEmpty = z.string().trim().min(1);

export const managedPolicySettingSchema = z
  .object({
    value: z.unknown(),
    locked: z.boolean(),
  })
  .strict();
export type ManagedPolicySetting = z.infer<typeof managedPolicySettingSchema>;

const providerIdList = z.array(trimmedNonEmpty).min(1);

export const managedProviderLimitsSchema = z
  .object({
    /** Yalnızca bu ajanlar başlatılabilir. */
    allowed: providerIdList.optional(),
    /** Bu ajanlar başlatılamaz ve seçicilerde gizlenir. */
    denied: providerIdList.optional(),
  })
  .strict();

export const managedUpdatesPolicySchema = z
  .object({
    /** `auto`: normal güncelleme akışı. `off`: güncelleme denetlenmez, indirilmez, kurulmaz. */
    mode: z.enum(['auto', 'off']),
  })
  .strict();

/**
 * Ayar olmayan kısıtlamalar: kullanıcı hiçbir yerde bunlardan çıkamaz. Boolean
 * yeteneklerde anahtarın olmaması "izinli" demektir; yalnızca `false` kısıtlar.
 */
export const managedPolicyLimitsSchema = z
  .object({
    /** Herhangi bir sohbetin kullanabileceği en geniş izin modu. */
    maxPermissionMode: permissionModeSchema.optional(),
    providers: managedProviderLimitsSchema.optional(),
    /** `false`: mobil/uzak cihaz erişimi (yerel ağ dinleyicisi) kapalı. */
    remoteAccess: z.boolean().optional(),
    /** `false`: yeni cihaz eşleştirmesi (QR ve hesapla eşleşme) kapalı. */
    devicePairing: z.boolean().optional(),
    /** `false`: dış ajanlar için yerel MCP sunucusu kapalı. */
    outsideAgents: z.boolean().optional(),
    updates: managedUpdatesPolicySchema.optional(),
  })
  .strict();
export type ManagedPolicyLimits = z.infer<typeof managedPolicyLimitsSchema>;

export const managedPolicyDocumentSchema = z
  .object({
    schemaVersion: z.literal(MANAGED_POLICY_SCHEMA_VERSION),
    /** Kullanıcıya "<organization> tarafından yönetiliyor" olarak gösterilir. */
    organization: trimmedNonEmpty,
    supportUrl: z
      .string()
      .trim()
      .regex(/^https?:\/\/\S+$/i, 'must be an http(s) URL')
      .optional(),
    settings: z.record(z.string(), managedPolicySettingSchema).optional(),
    limits: managedPolicyLimitsSchema.optional(),
  })
  .strict();
export type ManagedPolicyDocument = z.infer<typeof managedPolicyDocumentSchema>;

/**
 * İstemcilerin (renderer) gördüğü özet: kilitli kontrolü açıklamaya yetecek kadar bilgi.
 * Kaynak yolu ve parmak izi yalnızca "ne yüklendi" sorusunu yanıtlamak içindir.
 */
export type ManagedPolicySummary = {
  organization: string;
  supportUrl?: string;
  source: string;
  fingerprint: string;
  /** Kullanıcının değiştiremeyeceği ayar yolları (`tasks.defaultPermissionMode` gibi). */
  lockedSettings: string[];
  /** Kullanıcının değiştirebileceği politika varsayılanları. */
  defaultedSettings: string[];
  limits: ManagedPolicyLimits;
};

/** `mode` tavandan daha geniş mi? Tavan yoksa hiçbir mod geniş sayılmaz. */
export function isPermissionModeAbove(
  mode: ManagedPermissionMode,
  ceiling: ManagedPermissionMode | undefined
): boolean {
  if (ceiling === undefined) return false;
  return PERMISSION_MODES.indexOf(mode) > PERMISSION_MODES.indexOf(ceiling);
}

/** Tavanın üzerindeki modu tavana indirir; altındakileri olduğu gibi bırakır. */
export function clampPermissionMode(
  mode: ManagedPermissionMode,
  ceiling: ManagedPermissionMode | undefined
): ManagedPermissionMode {
  return isPermissionModeAbove(mode, ceiling) && ceiling !== undefined ? ceiling : mode;
}

/** "Example Corp's policy does not allow remote access." */
export function managedPolicyDeniedMessage(organization: string, capability: string): string {
  return `${organization}'s policy does not allow ${capability}.`;
}

export function managedPermissionCeilingMessage(
  organization: string,
  ceiling: ManagedPermissionMode
): string {
  return `${organization} limits conversations to the "${PERMISSION_MODE_LABELS[ceiling]}" permission mode or narrower.`;
}

export function managedUpdatesMessage(organization: string): string {
  return `${organization} manages Orkestra updates.`;
}

/** Politika bu ajanın çalışmasına izin veriyor mu? */
export function isManagedProviderAllowed(
  limits: ManagedPolicyLimits | undefined,
  providerId: string
): boolean {
  const providers = limits?.providers;
  if (!providers) return true;
  if (providers.allowed && !providers.allowed.includes(providerId)) return false;
  if (providers.denied?.includes(providerId)) return false;
  return true;
}
