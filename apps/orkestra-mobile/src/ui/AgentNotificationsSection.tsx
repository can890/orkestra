// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/mobile/src/features/settings/SettingsNotificationsRouteScreen.tsx
// Aynı yapı: ana anahtar, kategori anahtarları, süren etkinlik anahtarı, izin/sistem ayarı
// yönlendirmeleri. T3'teki bulut hesabı/cihaz kaydı yerine yerel servis durumu gösterilir.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  isAgentNotificationBridgeAvailable,
  openBatteryOptimizationSettings,
  openNotificationChannelSettings,
  readAgentNotificationStatus,
  requestNotificationPermission,
  describeHostNotificationStatus,
  type AgentNotificationStatus,
} from '@/core/agent-notifications/native';
import {
  AGENT_NOTIFICATION_CATEGORIES,
  agentNotificationPrefs,
  type AgentNotificationPrefs,
} from '@/core/agent-notifications/preferences';
import type { PairingRecord } from '@/core/pairing-store';

const STATUS_REFRESH_MS = 3_000;

function CheckRow(props: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  description?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="check-row agent-notify-row">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className="agent-notify-row-text">
        <span>{props.label}</span>
        {props.description ? <span className="muted-note small">{props.description}</span> : null}
      </span>
    </label>
  );
}

/** Ayarlar → Ajan bildirimleri. Tercihleri yazar; yerel servisi App içindeki eşitleme kancası kurar. */
export function AgentNotificationsSection(props: { hosts: readonly PairingRecord[] }) {
  const prefs = useSyncExternalStore(
    agentNotificationPrefs.subscribe,
    agentNotificationPrefs.get,
    agentNotificationPrefs.get
  );
  const bridge = isAgentNotificationBridgeAvailable();
  const [status, setStatus] = useState<AgentNotificationStatus>(() =>
    readAgentNotificationStatus()
  );

  const refresh = useCallback(() => setStatus(readAgentNotificationStatus()), []);
  useEffect(() => {
    if (!bridge) return;
    const timer = setInterval(refresh, STATUS_REFRESH_MS);
    window.addEventListener('sovra:resume', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('sovra:resume', refresh);
    };
  }, [bridge, refresh]);

  const update = (patch: Partial<AgentNotificationPrefs>) => {
    agentNotificationPrefs.update(patch);
    // Eşitleme kancası bir sonraki çizimde servisi yapılandırır; durumu kısa süre sonra tazele.
    setTimeout(refresh, 400);
  };

  const enable = (checked: boolean) => {
    if (checked && status.permission === 'denied') requestNotificationPermission();
    update({ enabled: checked });
  };

  return (
    <section className="wb-section">
      <div className="wb-section-head">
        <span className="wb-section-title">Ajan bildirimleri</span>
      </div>
      <div className="panel-card agent-notify-card">
        {!bridge ? (
          <p className="muted-note">
            Arka plan bildirimleri yalnızca Android uygulamasında çalışır.
          </p>
        ) : null}
        <CheckRow
          checked={prefs.enabled}
          disabled={!bridge}
          label="Arka plan bildirimleri"
          description="Uygulama kapalıyken de bir ajan işini bitirince, hata verince, onay bekleyince ya da soru sorunca bildirim alın. Telefon eşleşmiş bilgisayarlarınıza doğrudan bağlı kalır (bulut ya da push servisi yok); bu yüzden kalıcı bir bildirim görünür."
          onChange={enable}
        />

        <div className="agent-notify-group">
          <span className="field-label">Bildirim türleri</span>
          {AGENT_NOTIFICATION_CATEGORIES.map((category) => (
            <CheckRow
              key={category.id}
              checked={prefs[category.id]}
              label={category.label}
              description={category.description}
              onChange={(checked) => update({ [category.id]: checked })}
            />
          ))}
          <CheckRow
            checked={prefs.ongoing}
            label="Çalışan ajanlar kartı"
            description="Süren işleri ve son 15 dakikadaki sonuçları tek bir kalıcı bildirimde özetler. Kartı bildirimden gizleyebilirsiniz; yeni etkinlik olunca yeniden görünür."
            onChange={(checked) => update({ ongoing: checked })}
          />
          <p className="muted-note small">
            Uygulama açıkken, ekranda olan sohbet için uyarı gösterilmez.
          </p>
        </div>

        {bridge && prefs.enabled ? (
          <div className="settings-list agent-notify-status">
            <div className="settings-row">
              <span className="settings-key">Bildirim izni</span>
              {status.permission === 'denied' || !status.notificationsEnabled ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() =>
                    status.permission === 'denied'
                      ? requestNotificationPermission()
                      : openNotificationChannelSettings()
                  }
                >
                  İzin ver
                </button>
              ) : (
                <span className="settings-val text-accent">Verildi</span>
              )}
            </div>
            <div className="settings-row">
              <span className="settings-key">Servis</span>
              <span className="settings-val">{status.running ? 'Çalışıyor' : 'Durdu'}</span>
            </div>
            {props.hosts.map((host) => (
              <div className="settings-row" key={host.hostId}>
                <span className="settings-key">{host.hostName || 'Bilgisayar'}</span>
                <span className="settings-val small">
                  {describeHostNotificationStatus(status.hosts[host.hostId])}
                </span>
              </div>
            ))}
            {status.batteryOptimized ? (
              <div className="settings-action-row">
                <p className="muted-note small">
                  Pil optimizasyonu arka plan bağlantısını kesebilir. Sovra'yı pil optimizasyonundan
                  muaf tutun; Samsung, Xiaomi, Huawei, OnePlus gibi cihazlarda ayrıca üreticinin pil
                  ayarlarında "arka planda çalışmaya izin ver" / "otomatik başlat" seçeneğini açın.
                </p>
                <button
                  type="button"
                  className="btn btn-secondary full"
                  onClick={openBatteryOptimizationSettings}
                >
                  Pil ayarlarını aç
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {bridge ? (
          <button
            type="button"
            className="btn btn-secondary full"
            onClick={openNotificationChannelSettings}
          >
            Android bildirim kanallarını aç
          </button>
        ) : null}
        <p className="muted-note small">
          Her tür ayrı bir Android bildirim kanalıdır; sistem ayarlarından tek tek sessize
          alabilirsiniz. Sınırlar: uygulamayı "Zorla durdur" ile kapatırsanız bildirimler uygulamayı
          yeniden açana dek gelmez; telefon bilgisayara ulaşamadığında (farklı ağ, tünel yok)
          bildirim de gelmez; bilgisayarda Ayarlar → Mobil erişim → "Ajan etkinliğini eşleşmiş
          cihazlarla paylaş" kapalıysa liste boş kalır.
        </p>
      </div>
    </section>
  );
}
