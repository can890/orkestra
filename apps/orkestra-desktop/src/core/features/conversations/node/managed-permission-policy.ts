// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/contracts/src/managedPolicy.ts
// (clampManagedRuntimeMode, managedRuntimeModeDenial) ve apps/server/src/policy/managedLimits.ts.
//
// Yönetilen politikanın sohbet başlatma/geçiş yollarındaki uygulaması: engelli ajan başlatılamaz,
// izin modu tavanın üzerindeyse başlatmada tavana indirilir, seçimde reddedilir. Politika yoksa
// her fonksiyon girdiyi değiştirmeden döner.
import {
  isPermissionModeAbove,
  managedPermissionCeilingMessage,
  PERMISSION_MODES,
  type ManagedPermissionMode,
} from '@orkestra/shared/managed-policy';
import {
  canonicalizePermissionMode,
  resolveDefaultPermissionForProvider,
} from '@core/features/conversations/api/default-permission-mode';
import {
  managedPermissionCeiling,
  managedProviderDenial,
} from '@core/primitives/managed-policy/api/node/active-policy';

export class ManagedPolicyDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedPolicyDeniedError';
  }
}

/** Engelli bir ajan için başlatmayı reddeder. */
export function assertProviderAllowedByPolicy(providerId: string | null | undefined): void {
  if (!providerId) return;
  const denial = managedProviderDenial(providerId);
  if (denial) throw new ManagedPolicyDeniedError(denial);
}

export type PermissionSelection = {
  modeId?: string | null | undefined;
  autoApprove?: boolean | undefined;
};

/**
 * Seçimi tavana indirir. Tavanın altındaki seçimler (ve tavan yoksa hepsi) aynen döner;
 * üstündekiler, sağlayıcının tavanı aşmayan en geniş moduna iner. Bazı sağlayıcıların
 * "düzenlemeleri onayla" eşlemesi aslında daha geniştir; bu yüzden tavandan aşağı doğru,
 * sağlayıcıdaki karşılığı tavanı aşmayan ilk mod seçilir. Hiçbiri uymuyorsa başlatma reddedilir.
 */
export function clampPermissionSelectionToPolicy(
  providerId: string,
  selection: PermissionSelection
): PermissionSelection & { clamped: boolean } {
  const limit = managedPermissionCeiling();
  if (!limit) return { ...selection, clamped: false };
  const mode = canonicalizePermissionMode(selection.modeId, selection.autoApprove);
  if (!isPermissionModeAbove(mode, limit.ceiling)) {
    // Mod izinli; yine de tavan `bypass` değilse otomatik onay kapalı kalmalı.
    return limit.ceiling !== 'bypass' && selection.autoApprove === true
      ? { ...selection, autoApprove: false, clamped: true }
      : { ...selection, clamped: false };
  }
  const candidates = PERMISSION_MODES.slice(0, PERMISSION_MODES.indexOf(limit.ceiling) + 1);
  for (const candidate of candidates.reverse()) {
    const allowed = resolveDefaultPermissionForProvider(providerId, candidate);
    const effective = canonicalizePermissionMode(allowed.modeId, allowed.autoApprove);
    if (!isPermissionModeAbove(effective, limit.ceiling)) {
      return { modeId: allowed.modeId ?? null, autoApprove: allowed.autoApprove, clamped: true };
    }
  }
  throw new ManagedPolicyDeniedError(
    `${managedPermissionCeilingMessage(limit.organization, limit.ceiling)} The "${providerId}" agent has no permission mode within that limit.`
  );
}

/** Seçilen mod tavanın üzerindeyse kullanıcıya gösterilecek ret nedeni. */
export function permissionModeDenial(
  modeId: string,
  autoApprove: boolean | undefined
): string | undefined {
  const limit = managedPermissionCeiling();
  if (!limit) return undefined;
  const mode: ManagedPermissionMode = canonicalizePermissionMode(modeId, autoApprove);
  return isPermissionModeAbove(mode, limit.ceiling)
    ? managedPermissionCeilingMessage(limit.organization, limit.ceiling)
    : undefined;
}

/** TUI ajanları için: tavan `bypass` değilse izinleri atlama bayrağı kullanılmaz. */
export function clampTuiAutoApprove(autoApprove: boolean | undefined): boolean {
  const limit = managedPermissionCeiling();
  if (autoApprove !== true) return false;
  return !limit || limit.ceiling === 'bypass';
}
