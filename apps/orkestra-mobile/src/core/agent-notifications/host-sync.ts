import { DEFAULT_DISCOVERY_URL } from '../discovery';
import { isValidAddress } from '../pairing';
import type { PairingRecord } from '../pairing-store';
import type { AgentNotificationPrefs } from './preferences';

/**
 * Yerel servisin bağlanacağı bilgisayar kaydı. `secret` eşleştirme sırrıdır: yalnızca yerel
 * köprüye (aynı süreç) verilir; servis onu Android Keystore ile şifreli saklar. Loglanmaz.
 */
export type NativeNotificationHost = {
  hostId: string;
  hostName: string;
  addresses: string[];
  port: number;
  deviceId: string;
  secret: string;
  discoveryUrl?: string;
};

const MAX_HOSTS = 8;
const MAX_ADDRESSES = 6;

/** Eşleşme kayıtlarından servise gidecek liste (geçersiz adresler/kayıtlar atlanır). */
export function nativeHostsFromRecords(
  records: readonly PairingRecord[]
): NativeNotificationHost[] {
  const out: NativeNotificationHost[] = [];
  for (const record of records) {
    if (out.length >= MAX_HOSTS) break;
    const addresses = record.addresses.filter(isValidAddress).slice(0, MAX_ADDRESSES);
    if (addresses.length === 0 || !record.secret || !record.deviceId) continue;
    const discoveryUrl = record.discoveryUrl ?? DEFAULT_DISCOVERY_URL;
    out.push({
      hostId: record.hostId,
      hostName: record.hostName,
      addresses,
      port: record.port,
      deviceId: record.deviceId,
      secret: record.secret,
      ...(discoveryUrl ? { discoveryUrl } : {}),
    });
  }
  return out;
}

/**
 * Bağlantıyı etkileyen alanların imzası (sır yalnızca özet olarak girer): değişmediyse servise
 * yeniden gönderilmez. Sır düz metin olarak imzaya girmez.
 */
export function hostsSignature(hosts: readonly NativeNotificationHost[]): string {
  return hosts
    .map((host) => {
      let digest = 0;
      for (let i = 0; i < host.secret.length; i += 1) {
        digest = (digest * 31 + host.secret.charCodeAt(i)) | 0;
      }
      return `${host.hostId}|${host.deviceId}|${host.port}|${host.addresses.join(',')}|${host.discoveryUrl ?? ''}|${digest}`;
    })
    .sort()
    .join('\n');
}

/** `SovraNative.agentNotifyConfigure` girdisi. Kapalıyken bilgisayar listesi gönderilmez. */
export function buildConfigurePayload(
  prefs: AgentNotificationPrefs,
  hosts: readonly NativeNotificationHost[] | null
): string {
  return JSON.stringify(prefs.enabled && hosts ? { prefs, hosts } : { prefs });
}
