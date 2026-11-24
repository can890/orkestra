// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/shared/src/managedPolicyFile.ts,
// apps/server/src/policy/ManagedPolicy.ts ve managedSettings.ts (doğrulama ve fail-closed kuralları).
import type { z } from 'zod';
import {
  isPermissionModeAbove,
  MANAGED_POLICY_SCHEMA_VERSION,
  managedPolicyDocumentSchema,
  PERMISSION_MODE_LABELS,
  type ManagedPermissionMode,
  type ManagedPolicyDocument,
} from './schema';
import { isManageableSettingPath, MANAGEABLE_SETTINGS } from './settings-catalog';

/** Doğrulanmış, uygulanmaya hazır politika. Değerler hiçbir zaman kullanıcı ayarlarına yazılmaz. */
export type ValidatedManagedPolicy = {
  document: ManagedPolicyDocument;
  /** Kilitli ayar yolu → zorunlu değer. */
  lockedSettings: ReadonlyMap<string, unknown>;
  /** Kilitsiz ayar yolu → yerleşik varsayılanın yerine geçen değer. */
  defaultSettings: ReadonlyMap<string, unknown>;
};

export type ManagedPolicyValidationError = {
  /** Politikanın okunduğu yer (dosya yolu ya da profil). */
  source: string;
  reason: string;
};

export type ManagedPolicyValidationResult =
  | { success: true; data: ValidatedManagedPolicy }
  | { success: false; error: ManagedPolicyValidationError };

export type ValidateManagedPolicyOptions = {
  source: string;
  /**
   * Bu derlemenin tanıdığı ajan kimlikleri. Verildiğinde bilinmeyen bir kimlik reddedilir:
   * yazım hatası olan bir izin listesi, sessizce her şeyi engelleyen bir politikaya dönüşmemeli.
   */
  knownProviderIds?: readonly string[];
};

/** Çalışmayı durduran politika hatasının tek biçimli metni. */
export function formatManagedPolicyError(error: ManagedPolicyValidationError): string {
  return `Orkestra cannot use the managed policy at ${error.source}: ${error.reason}. It will not start until an administrator fixes this.`;
}

/** JSON metninden ya da önceden ayrıştırılmış bir değerden (yapılandırma profili) doğrular. */
export function validateManagedPolicy(
  raw: unknown,
  options: ValidateManagedPolicyOptions
): ManagedPolicyValidationResult {
  const fail = (reason: string): ManagedPolicyValidationResult => ({
    success: false,
    error: { source: options.source, reason },
  });

  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch (error) {
      return fail(
        `it is not valid JSON (${error instanceof Error ? error.message : String(error)})`
      );
    }
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('it must be a JSON object');
  }
  const version = (value as Record<string, unknown>).schemaVersion;
  if (typeof version === 'number' && version > MANAGED_POLICY_SCHEMA_VERSION) {
    return fail(
      `it was written for a newer Orkestra (schemaVersion ${version}); this version supports schemaVersion ${MANAGED_POLICY_SCHEMA_VERSION}. Upgrade Orkestra before deploying this policy`
    );
  }

  const parsed = managedPolicyDocumentSchema.safeParse(value);
  if (!parsed.success) {
    return fail(`it does not match the policy schema (${formatIssues(parsed.error)})`);
  }
  const document = parsed.data;

  const lockedSettings = new Map<string, unknown>();
  const defaultSettings = new Map<string, unknown>();
  for (const [path, setting] of Object.entries(document.settings ?? {})) {
    if (!isManageableSettingPath(path)) {
      return fail(
        `"settings.${path}" is not a setting a policy can manage (run "policy settings" to list them)`
      );
    }
    const checked = MANAGEABLE_SETTINGS[path].schema.safeParse(setting.value);
    if (!checked.success) {
      return fail(`"settings.${path}.value" is invalid (${formatIssues(checked.error)})`);
    }
    (setting.locked ? lockedSettings : defaultSettings).set(path, checked.data);
  }

  const limits = document.limits;
  const providers = limits?.providers;
  if (providers?.allowed && providers.denied) {
    return fail('use either "limits.providers.allowed" or "limits.providers.denied", not both');
  }
  if (options.knownProviderIds) {
    const known = new Set(options.knownProviderIds);
    for (const id of [...(providers?.allowed ?? []), ...(providers?.denied ?? [])]) {
      if (!known.has(id)) {
        return fail(
          `"${id}" is not an agent this version of Orkestra knows (known: ${[...known].sort().join(', ')})`
        );
      }
    }
  }

  const ceiling = limits?.maxPermissionMode;
  if (ceiling !== undefined) {
    const defaultMode = (lockedSettings.get('tasks.defaultPermissionMode') ??
      defaultSettings.get('tasks.defaultPermissionMode')) as ManagedPermissionMode | undefined;
    if (defaultMode !== undefined && isPermissionModeAbove(defaultMode, ceiling)) {
      return fail(
        `"settings.tasks.defaultPermissionMode" (${PERMISSION_MODE_LABELS[defaultMode]}) is broader than "limits.maxPermissionMode" (${PERMISSION_MODE_LABELS[ceiling]})`
      );
    }
    const autoApprove =
      lockedSettings.get('tasks.autoApproveByDefault') ??
      defaultSettings.get('tasks.autoApproveByDefault');
    if (autoApprove === true && ceiling !== 'bypass') {
      return fail(
        '"settings.tasks.autoApproveByDefault" cannot be true while "limits.maxPermissionMode" forbids skipping permissions'
      );
    }
  }

  return { success: true, data: { document, lockedSettings, defaultSettings } };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}
