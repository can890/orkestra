/**
 * `SovraNative.agentNotify*` köprüsü (Android `AgentNotifyBridge`). Tarayıcıda/testte köprü yoktur:
 * tüm çağrılar sessizce no-op olur ve `isAgentNotificationBridgeAvailable()` `false` döner.
 */

export type NativePermissionState = 'granted' | 'denied' | 'not-required' | 'unknown';

export type AgentNotificationStatus = {
  supported: boolean;
  sdk: number | null;
  enabled: boolean;
  running: boolean;
  permission: NativePermissionState;
  notificationsEnabled: boolean;
  /** Pil optimizasyonu uygulamayı kısıtlıyor mu? (Muafiyet önerilir.) */
  batteryOptimized: boolean;
  /** hostId → `connecting` | `connected` | `offline` | `unsupported` | `revoked` | `paused` … */
  hosts: Record<string, string>;
};

type AgentNotifyNativeApi = {
  agentNotifyConfigure?: (json: string) => string;
  agentNotifyStatus?: () => string;
  agentNotifyRequestPermission?: () => void;
  agentNotifyOpenBatterySettings?: () => boolean;
  agentNotifyOpenNotificationSettings?: () => boolean;
  agentNotifySetConversation?: (hostId: string, conversationId: string) => void;
  agentNotifyConsumeLaunchTarget?: () => string;
};

function api(): AgentNotifyNativeApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { SovraNative?: AgentNotifyNativeApi }).SovraNative;
}

export const UNSUPPORTED_STATUS: AgentNotificationStatus = {
  supported: false,
  sdk: null,
  enabled: false,
  running: false,
  permission: 'unknown',
  notificationsEnabled: false,
  batteryOptimized: false,
  hosts: {},
};

export function isAgentNotificationBridgeAvailable(): boolean {
  const native = api();
  return typeof native?.agentNotifyConfigure === 'function';
}

/** Köprünün döndürdüğü durum JSON'unu gevşekçe doğrular. */
export function parseAgentNotificationStatus(
  raw: string | null | undefined
): AgentNotificationStatus {
  if (!raw) return UNSUPPORTED_STATUS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return UNSUPPORTED_STATUS;
  }
  if (typeof value !== 'object' || value === null) return UNSUPPORTED_STATUS;
  const v = value as Record<string, unknown>;
  const permission = v['permission'];
  const hosts: Record<string, string> = {};
  if (typeof v['hosts'] === 'object' && v['hosts'] !== null) {
    for (const [key, status] of Object.entries(v['hosts'] as Record<string, unknown>)) {
      if (typeof status === 'string') hosts[key] = status;
    }
  }
  return {
    supported: v['supported'] === true,
    sdk: typeof v['sdk'] === 'number' ? v['sdk'] : null,
    enabled: v['enabled'] === true,
    running: v['running'] === true,
    permission:
      permission === 'granted' || permission === 'denied' || permission === 'not-required'
        ? permission
        : 'unknown',
    notificationsEnabled: v['notificationsEnabled'] === true,
    batteryOptimized: v['batteryOptimized'] === true,
    hosts,
  };
}

export function configureAgentNotifications(payloadJson: string): AgentNotificationStatus {
  try {
    const native = api();
    if (!native?.agentNotifyConfigure) return UNSUPPORTED_STATUS;
    return parseAgentNotificationStatus(native.agentNotifyConfigure(payloadJson));
  } catch {
    return UNSUPPORTED_STATUS;
  }
}

export function readAgentNotificationStatus(): AgentNotificationStatus {
  try {
    const native = api();
    if (!native?.agentNotifyStatus) return UNSUPPORTED_STATUS;
    return parseAgentNotificationStatus(native.agentNotifyStatus());
  } catch {
    return UNSUPPORTED_STATUS;
  }
}

export function requestNotificationPermission(): void {
  try {
    api()?.agentNotifyRequestPermission?.();
  } catch {
    // yoksay
  }
}

export function openBatteryOptimizationSettings(): void {
  try {
    api()?.agentNotifyOpenBatterySettings?.();
  } catch {
    // yoksay
  }
}

export function openNotificationChannelSettings(): void {
  try {
    api()?.agentNotifyOpenNotificationSettings?.();
  } catch {
    // yoksay
  }
}

/** Ön planda açık sohbet; sohbet ekranında değilken `null`. */
export function setVisibleConversation(
  target: { hostId: string; conversationId: string } | null
): void {
  try {
    api()?.agentNotifySetConversation?.(target?.hostId ?? '', target?.conversationId ?? '');
  } catch {
    // yoksay
  }
}

export function consumeLaunchTarget(): string | null {
  try {
    const raw = api()?.agentNotifyConsumeLaunchTarget?.();
    return raw ? raw : null;
  } catch {
    return null;
  }
}

/** Ayarlar ekranında gösterilen bilgisayar bağlantı durumu metni. */
export function describeHostNotificationStatus(status: string | undefined): string {
  switch (status) {
    case 'connected':
      return 'Bağlı';
    case 'connecting':
      return 'Bağlanıyor…';
    case 'offline':
      return 'Ulaşılamıyor (yeniden denenecek)';
    case 'unsupported':
      return 'Bilgisayardaki Orkestra bu özelliği desteklemiyor (güncelleyin)';
    case 'paused':
      return 'Bilgisayarda ajan etkinliği paylaşımı kapalı';
    case 'revoked':
      return 'Eşleşme iptal edilmiş; yeniden eşleştirin';
    case 'stopped':
      return 'Durduruldu';
    default:
      return 'Beklemede';
  }
}
