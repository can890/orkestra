import { useState, useSyncExternalStore } from 'react';
import type { AppSession } from '@/core/app-session';
import type { ConnectionManager } from '@/core/connection-manager';
import { describeStatus } from '@/core/connection-state';
import type { PairingRecord } from '@/core/pairing-store';
import { getThemeMode, setThemeMode, subscribeTheme, type ThemeMode } from '@/core/theme';
import { ConnectionPill, WorkbenchHeader } from '../components';
import { useConnectionStatus } from '../hooks';
import { LaptopIcon, RefreshIcon } from '../icons';

const THEME_OPTIONS: readonly { id: ThemeMode; label: string }[] = [
  { id: 'dark', label: 'Koyu' },
  { id: 'light', label: 'Açık' },
  { id: 'system', label: 'Sistem' },
];

export function SettingsScreen(props: {
  session: AppSession;
  record: PairingRecord;
  manager: ConnectionManager;
  onOpenMenu: () => void;
}) {
  const status = useConnectionStatus(props.manager);
  const theme = useSyncExternalStore(subscribeTheme, getThemeMode, getThemeMode);
  const [confirming, setConfirming] = useState(false);

  return (
    <main className="screen">
      <WorkbenchHeader title="Ayarlar" subtitle="Orkestra Mobil" onMenu={props.onOpenMenu} />

      <div className="screen-body with-dock">
        <section className="wb-section">
          <div className="wb-section-head">
            <span className="wb-section-title">
              <LaptopIcon size={13} />
              <span>Masaüstü bağlantısı</span>
            </span>
          </div>
          <div className="panel-card settings-list">
            <div className="settings-row">
              <span className="settings-key">Bilgisayar</span>
              <span className="settings-val">{props.record.hostName || 'Adsız Mac'}</span>
            </div>
            <div className="settings-row">
              <span className="settings-key">Durum</span>
              <ConnectionPill status={status} hostName={describeStatus(status)} />
            </div>
            <div className="settings-row">
              <span className="settings-key">Uç noktalar</span>
              <span className="settings-val mono small">
                {props.record.addresses
                  .map((address) => `${address}:${props.record.port}`)
                  .join(', ')}
              </span>
            </div>
            <div className="settings-action-row">
              <button
                type="button"
                className="btn btn-secondary full"
                onClick={() => props.session.refresh()}
              >
                <RefreshIcon size={14} />
                <span>Bağlantıyı yenile</span>
              </button>
            </div>
          </div>
        </section>

        <section className="wb-section">
          <div className="wb-section-head">
            <span className="wb-section-title">Görünüm</span>
          </div>
          <div className="panel-card">
            <p className="muted-note">
              Orkestra Mac arayüzüyle uyumlu koyu veya açık temayı seçebilirsiniz.
            </p>
            <div className="segmented" role="radiogroup" aria-label="Tema seçimi">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={theme === option.id}
                  className={`segmented-btn ${theme === option.id ? 'is-active' : ''}`}
                  onClick={() => setThemeMode(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="wb-section">
          <div className="wb-section-head">
            <span className="wb-section-title">Cihaz eşleşmesi</span>
          </div>
          <div className="panel-card">
            <p className="muted-note">
              Eşleşmeyi kaldırınca bu telefondaki şifreleme anahtarı silinir. Masaüstünde de Ayarlar
              → Mobil erişim sayfasından bu cihazı iptal edebilirsiniz.
            </p>
            {confirming ? (
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-danger flex1"
                  onClick={() => void props.session.unpair()}
                >
                  Evet, kaldır
                </button>
                <button
                  type="button"
                  className="btn btn-secondary flex1"
                  onClick={() => setConfirming(false)}
                >
                  Vazgeç
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-danger-outline full"
                onClick={() => setConfirming(true)}
              >
                Eşleşmeyi kaldır
              </button>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
