import type { PairingRecord } from '../pairing-store';
import { buildConfigurePayload, hostsSignature, nativeHostsFromRecords } from './host-sync';
import type { AgentNotificationPrefs } from './preferences';

/**
 * Tercihler ya da eşleşmiş bilgisayarlar (adres güncellemesi, ekleme/çıkarma) değişince yerel
 * servisi yeniden yapılandırır; aynı içerik için tekrar çağırmaz. Kapalıyken bilgisayar listesi
 * (sırlar) servise hiç gönderilmez ve servis kendi kopyasını siler.
 */
export class AgentNotificationSync {
  private lastKey: string | null = null;

  constructor(private readonly configure: (payloadJson: string) => void) {}

  sync(prefs: AgentNotificationPrefs, records: readonly PairingRecord[]): boolean {
    const hosts = prefs.enabled ? nativeHostsFromRecords(records) : null;
    const key = `${JSON.stringify(prefs)}#${hosts ? hostsSignature(hosts) : '-'}`;
    if (key === this.lastKey) return false;
    this.lastKey = key;
    this.configure(buildConfigurePayload(prefs, hosts));
    return true;
  }

  /** Örn. izin verildikten sonra: bir sonraki `sync` her durumda gönderir. */
  reset(): void {
    this.lastKey = null;
  }
}
