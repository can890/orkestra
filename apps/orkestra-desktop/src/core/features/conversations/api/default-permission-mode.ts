import type { DefaultPermissionMode } from '@core/primitives/app-settings/api';

export type DefaultPermissionModeOption = {
  id: DefaultPermissionMode;
  label: string;
  description: string;
};

export const DEFAULT_PERMISSION_MODE_OPTIONS: readonly DefaultPermissionModeOption[] = [
  {
    id: 'default',
    label: 'Manual',
    description: 'Değişiklik yapmadan önce her zaman sor',
  },
  {
    id: 'acceptEdits',
    label: 'Düzenlemeleri onayla',
    description: 'Tüm dosya düzenlemelerini otomatik kabul et',
  },
  {
    id: 'plan',
    label: 'Plan',
    description: 'Değişiklik yapmadan önce plan oluştur',
  },
  {
    id: 'auto',
    label: 'Otomatik',
    description: 'İzin kararlarını ajan yönetsin',
  },
  {
    id: 'bypass',
    label: 'İzinleri atla',
    description: 'Tüm izin onaylarını otomatik atla',
  },
];

export function permissionModeLabel(mode: DefaultPermissionMode): string {
  return (
    DEFAULT_PERMISSION_MODE_OPTIONS.find((item) => item.id === mode)?.label ??
    DEFAULT_PERMISSION_MODE_OPTIONS[0]!.label
  );
}

/**
 * Seçilen genel varsayılan izin modunu ilgili yapay zeka sağlayıcısının ACP `modeId` ve `autoApprove`
 * parametrelerine dönüştürür.
 */
export function resolveDefaultPermissionForProvider(
  providerId: string,
  mode: DefaultPermissionMode
): { autoApprove: boolean; modeId?: string } {
  switch (mode) {
    case 'default':
      return {
        autoApprove: false,
        modeId:
          providerId === 'grok'
            ? 'ask'
            : providerId === 'claude' || providerId === 'antigravity'
              ? 'default'
              : undefined,
      };
    case 'acceptEdits':
      return {
        autoApprove: false,
        modeId:
          providerId === 'claude'
            ? 'acceptEdits'
            : providerId === 'grok'
              ? 'always-approve'
              : 'auto',
      };
    case 'plan':
      return {
        autoApprove: false,
        modeId:
          providerId === 'codex'
            ? 'read-only'
            : providerId === 'grok'
              ? 'ask'
              : 'plan',
      };
    case 'auto':
      return {
        autoApprove: false,
        modeId: providerId === 'grok' ? 'always-approve' : 'auto',
      };
    case 'bypass':
      return {
        autoApprove: true,
        modeId:
          providerId === 'claude'
            ? 'bypassPermissions'
            : providerId === 'antigravity'
              ? 'auto'
              : providerId === 'grok'
                ? 'always-approve'
                : providerId === 'codex'
                  ? 'full-access'
                  : 'bypassPermissions',
      };
  }
}

/**
 * Herhangi bir sağlayıcıya ait canlı ACP `modeId` değerini ortak `DefaultPermissionMode` sınıfına çevirir.
 */
export function canonicalizePermissionMode(
  rawModeId: string | null | undefined,
  autoApprove?: boolean
): DefaultPermissionMode {
  const normalized = typeof rawModeId === 'string' ? rawModeId.trim() : '';
  if (
    normalized === 'bypassPermissions' ||
    normalized === 'full-access' ||
    normalized === 'agent-full-access' ||
    normalized === 'always-approve' ||
    normalized === 'yolo'
  ) {
    return 'bypass';
  }
  if (normalized === 'acceptEdits') {
    return 'acceptEdits';
  }
  if (normalized === 'plan' || normalized === 'read-only') {
    return 'plan';
  }
  if (normalized === 'auto') {
    return autoApprove === true ? 'bypass' : 'auto';
  }
  if (normalized === 'default' || normalized === 'ask') {
    return autoApprove === true ? 'bypass' : 'default';
  }
  return autoApprove === true ? 'bypass' : 'default';
}
