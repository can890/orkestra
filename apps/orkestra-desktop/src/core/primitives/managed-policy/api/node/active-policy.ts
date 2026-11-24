// Süreç genelinde yüklenmiş yönetilen politika. Açılışta bir kez ayarlanır ve süreç boyunca
// değişmez (politika yalnızca başlangıçta okunur). Politika yoksa her denetim tek bir
// `undefined` karşılaştırmasıyla kısa devre yapar: bugünkü davranış aynen korunur.
import {
  isManagedProviderAllowed,
  managedPolicyDeniedMessage,
  managedUpdatesMessage,
  type ManagedPermissionMode,
} from '@orkestra/shared/managed-policy';
import type { LoadedManagedPolicy } from '@orkestra/shared/managed-policy/node';
import { createManagedSettingsLayer, type ManagedSettingsLayer } from '../managed-settings';

export type ActiveManagedPolicy = LoadedManagedPolicy & {
  settings: ManagedSettingsLayer;
};

let active: ActiveManagedPolicy | undefined;

export function setActiveManagedPolicy(loaded: LoadedManagedPolicy | undefined): void {
  active = loaded ? { ...loaded, settings: createManagedSettingsLayer(loaded.policy) } : undefined;
}

export function getActiveManagedPolicy(): ActiveManagedPolicy | undefined {
  return active;
}

const CAPABILITY_LABELS = {
  remoteAccess: 'remote access from other devices',
  devicePairing: 'pairing new devices',
  outsideAgents: 'the outside-agent MCP server',
} as const;

export type ManagedCapability = keyof typeof CAPABILITY_LABELS;

/** Yeteneği kapatan politikanın kullanıcıya gösterilecek nedeni; izinliyse `undefined`. */
export function managedCapabilityDenial(capability: ManagedCapability): string | undefined {
  const policy = active;
  if (!policy) return undefined;
  const limits = policy.policy.document.limits;
  // Uzak erişim kapalıysa eşleştirme de anlamsızdır.
  const denied =
    limits?.[capability] === false ||
    (capability === 'devicePairing' && limits?.remoteAccess === false);
  return denied
    ? managedPolicyDeniedMessage(policy.summary.organization, CAPABILITY_LABELS[capability])
    : undefined;
}

/** Ajan politikayla engellendiyse nedeni; izinliyse `undefined`. */
export function managedProviderDenial(providerId: string): string | undefined {
  const policy = active;
  if (!policy || isManagedProviderAllowed(policy.policy.document.limits, providerId)) {
    return undefined;
  }
  return managedPolicyDeniedMessage(policy.summary.organization, `the "${providerId}" agent`);
}

export function isManagedProviderHidden(providerId: string): boolean {
  return managedProviderDenial(providerId) !== undefined;
}

/** Güncellemeler politikayla kapatıldıysa nedeni. */
export function managedUpdatesDenial(): string | undefined {
  const policy = active;
  return policy?.policy.document.limits?.updates?.mode === 'off'
    ? managedUpdatesMessage(policy.summary.organization)
    : undefined;
}

/** Herhangi bir sohbetin kullanabileceği en geniş izin modu. */
export function managedPermissionCeiling():
  | { ceiling: ManagedPermissionMode; organization: string }
  | undefined {
  const policy = active;
  const ceiling = policy?.policy.document.limits?.maxPermissionMode;
  return policy && ceiling ? { ceiling, organization: policy.summary.organization } : undefined;
}

/** Ayar yolu politikayla kilitliyse zorunlu değeri ve kuruluşu; değilse `undefined`. */
export function managedSettingLock(
  path: string
): { value: unknown; organization: string } | undefined {
  const policy = active;
  if (!policy || !policy.policy.lockedSettings.has(path)) return undefined;
  return {
    value: policy.policy.lockedSettings.get(path),
    organization: policy.summary.organization,
  };
}
