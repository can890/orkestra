import { useState, useSyncExternalStore } from 'react';
import type { AppSession } from '@/core/app-session';
import type { ConnectionManager } from '@/core/connection-manager';
import { describeStatus } from '@/core/connection-state';
import { DEFAULT_DISCOVERY_URL } from '@/core/discovery';
import { isValidAddress } from '@/core/pairing';
import type { PairingRecord } from '@/core/pairing-store';
import { getThemeMode, setThemeMode, subscribeTheme, type ThemeMode } from '@/core/theme';
import { ConnectionPill, ErrorNote, SovraMark, WorkbenchHeader } from '../components';
import { useConnectionStatus } from '../hooks';
import { CheckIcon, GlobeIcon, LaptopIcon, PlusIcon, RefreshIcon, ServerIcon } from '../icons';

const APP_VERSION = '1.2.43';

const THEME_OPTIONS: readonly { id: ThemeMode; label: string }[] = [
  { id: 'dark', label: 'Koyu' },
  { id: 'light', label: 'Açık' },
  { id: 'system', label: 'Sistem' },
];

function formatEndpoint(address: string, port: number): string {
  if (address.startsWith('wss://') || address.startsWith('ws://')) {
    return address;
  }
  return `${address}:${port}`;
}

export function SettingsScreen(props: {
  session: AppSession;
  record: PairingRecord;
  hosts: PairingRecord[];
  manager: ConnectionManager;
  onAddHost: () => void;
  onOpenMenu: () => void;
}) {
  const status = useConnectionStatus(props.manager);
  const theme = useSyncExternalStore(subscribeTheme, getThemeMode, getThemeMode);
  const [confirming, setConfirming] = useState(false);
  const [customAddr, setCustomAddr] = useState('');
  const [addrError, setAddrError] = useState<string | null>(null);
  const [addrSaved, setAddrSaved] = useState(false);

  const hasTunnel = props.record.addresses.some((a) => a.startsWith('wss://'));
  const hasDiscovery = Boolean(props.record.discoveryUrl ?? DEFAULT_DISCOVERY_URL);

  async function handleAddAddress(): Promise<void> {
    const trimmed = customAddr.trim();
    if (!isValidAddress(trimmed)) {
      setAddrError('Geçerli bir IP, alan adı ya da wss:// tünel adresi girin.');
      return;
    }
    setAddrError(null);
    const ok = await props.session.addAddress(props.record.hostId, trimmed);
    if (ok) {
      setCustomAddr('');
      setAddrSaved(true);
      setTimeout(() => setAddrSaved(false), 2500);
    } else {
      setAddrError('Adres kaydedilemedi.');
    }
  }

  return (
    <main className="screen">
      <WorkbenchHeader title="Ayarlar" subtitle={`Sovra v${APP_VERSION}`} onMenu={props.onOpenMenu} />

      <div className="screen-body with-dock">
        <section className="brand-identity-card">
          <div className="brand-identity-left">
            <SovraMark size={42} />
            <div className="brand-identity-meta">
              <div className="brand-identity-name-row">
                <strong className="brand-identity-name">Sovra</strong>
                <span className="plan-pill">v{APP_VERSION}</span>
              </div>
              <span className="brand-identity-sub">
                {props.record.hostName || 'Bilgisayar'} ·{' '}
                {hasTunnel || hasDiscovery ? 'Her yerden (LAN + Tünel)' : 'Yerel ağ'}
              </span>
            </div>
          </div>
          <ConnectionPill
            status={status}
            hostName={status.kind === 'connected' ? 'Çevrimiçi' : undefined}
          />
        </section>

        {/* Bilgisayarlar (Mac / Huawei) & Otomatik Failover */}
        <section className="wb-section">
          <div className="wb-section-head">
            <span className="wb-section-title">
              <ServerIcon size={13} />
              <span>Bilgisayarlar</span>
            </span>
            <button
              type="button"
              className="section-link"
              onClick={props.onAddHost}
            >
              + Bilgisayar ekle
            </button>
          </div>
          <div className="panel-card host-list-card">
            <div className="host-list">
              {props.hosts.map((host) => {
                const isActive = host.hostId === props.record.hostId;
                const tunnel = host.addresses.find((a) => a.startsWith('wss://'));
                return (
                  <button
                    key={host.hostId}
                    type="button"
                    className={`host-row ${isActive ? 'is-active' : ''}`}
                    onClick={() => void props.session.switchHost(host.hostId)}
                  >
                    <span className="host-row-icon">
                      <LaptopIcon size={16} />
                    </span>
                    <span className="host-row-main">
                      <span className="host-row-name">{host.hostName || 'Adsız bilgisayar'}</span>
                      <span className="host-row-sub mono">
                        {tunnel ? tunnel.replace(/^wss:\/\//, '') : `${host.addresses[0]}:${host.port}`}
                      </span>
                    </span>
                    {isActive ? (
                      <span className="host-active-badge">
                        <CheckIcon size={12} />
                        <span>Aktif</span>
                      </span>
                    ) : (
                      <span className="host-switch-label">Geç</span>
                    )}
                  </button>
                );
              })}
            </div>
            <p className="muted-note">
              {props.hosts.length > 1
                ? 'Otomatik geçiş (failover) açık: aktif bilgisayar kapalıysa telefon diğer açık bilgisayara otomatik bağlanır.'
                : 'Mac ve Huawei’yi birlikte eklediğinizde biri kapalıysa telefon otomatik olarak açık olana geçer.'}
            </p>
            <button type="button" className="btn btn-secondary full" onClick={props.onAddHost}>
              <PlusIcon size={15} />
              <span>Yeni bilgisayar ekle (Mac / Huawei)</span>
            </button>
          </div>
        </section>

        {/* Aktif Bağlantı & İnternet Tüneli */}
        <section className="wb-section">
          <div className="wb-section-head">
            <span className="wb-section-title">
              <GlobeIcon size={13} />
              <span>Uzak bağlantı ve tünel</span>
            </span>
          </div>
          <div className="panel-card settings-list">
            <div className="settings-row">
              <span className="settings-key">Aktif bilgisayar</span>
              <span className="settings-val">{props.record.hostName || 'Adsız bilgisayar'}</span>
            </div>
            <div className="settings-row">
              <span className="settings-key">Durum</span>
              <ConnectionPill status={status} hostName={describeStatus(status)} />
            </div>
            <div className="settings-row">
              <span className="settings-key">Otomatik tünel keşfi</span>
              <span className="settings-val text-accent">
                {hasDiscovery ? 'Etkin (5G / dış ağ)' : 'Kapalı'}
              </span>
            </div>
            <div className="settings-row">
              <span className="settings-key">Uç noktalar</span>
              <span className="settings-val mono small">
                {props.record.addresses
                  .map((address) => formatEndpoint(address, props.record.port))
                  .join(', ')}
              </span>
            </div>
            <div className="settings-action-row settings-tunnel-form">
              <div className="btn-row">
                <input
                  type="text"
                  className="text-input mono small flex1"
                  value={customAddr}
                  placeholder="wss://….trycloudflare.com veya IP"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => setCustomAddr(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!customAddr.trim()}
                  onClick={() => void handleAddAddress()}
                >
                  {addrSaved ? 'Eklendi' : 'Ekle'}
                </button>
              </div>
              <ErrorNote message={addrError} />
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
              Sovra masaüstü uygulamasıyla uyumlu obsidyen koyu veya açık temayı seçebilirsiniz.
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
              Eşleşmeyi kaldırınca seçili bilgisayarın şifreleme anahtarı bu telefondan silinir.
            </p>
            {confirming ? (
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-danger flex1"
                  onClick={() => {
                    setConfirming(false);
                    void props.session.removeHost(props.record.hostId);
                  }}
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
                {props.hosts.length > 1
                  ? `"${props.record.hostName}" eşleşmesini kaldır`
                  : 'Eşleşmeyi kaldır'}
              </button>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
