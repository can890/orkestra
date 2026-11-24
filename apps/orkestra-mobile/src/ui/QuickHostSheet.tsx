import type { AppSession } from '@/core/app-session';
import { describeStatus, type ConnectionStatus } from '@/core/connection-state';
import { triggerHaptic } from '@/core/native-bridge';
import type { PairingRecord } from '@/core/pairing-store';
import { CheckIcon, GlobeIcon, LaptopIcon, PlusIcon, RefreshIcon, XIcon } from './icons';

export function QuickHostSheet(props: {
  open: boolean;
  session: AppSession;
  activeRecord: PairingRecord;
  hosts: PairingRecord[];
  status: ConnectionStatus;
  onAddHost: () => void;
  onClose: () => void;
}) {
  if (!props.open) return null;

  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label="Bilgisayar değiştir">
      <div className="sheet-backdrop" onClick={props.onClose} />
      <div className="sheet-panel">
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-header">
          <div className="sheet-title-group">
            <h2 className="sheet-title">Bilgisayarlar</h2>
            <p className="sheet-subtitle">{describeStatus(props.status)}</p>
          </div>
          <button
            type="button"
            className="wb-icon-btn sm"
            onClick={() => {
              triggerHaptic('light');
              props.session.refresh();
            }}
            aria-label="Bağlantıyı yenile"
            title="Bağlantıyı yenile"
          >
            <RefreshIcon size={15} />
          </button>
          <button
            type="button"
            className="wb-icon-btn sm"
            onClick={props.onClose}
            aria-label="Kapat"
          >
            <XIcon size={17} />
          </button>
        </div>

        <div className="sheet-body">
          <div className="host-list">
            {props.hosts.map((host) => {
              const isActive = host.hostId === props.activeRecord.hostId;
              const tunnel = host.addresses.find((a) => a.startsWith('wss://'));
              const connected = isActive && props.status.kind === 'connected';
              const failed = isActive && props.status.kind === 'failed';
              return (
                <button
                  key={host.hostId}
                  type="button"
                  className={`host-row ${isActive ? 'is-active' : ''}`}
                  onClick={() => {
                    triggerHaptic('medium');
                    if (!isActive) {
                      void props.session.switchHost(host.hostId);
                    } else {
                      props.session.refresh();
                    }
                    props.onClose();
                  }}
                >
                  <span className="host-row-icon">
                    <LaptopIcon size={16} />
                  </span>
                  <span className="host-row-main">
                    <span className="host-row-name-line">
                      <span className="host-row-name">{host.hostName || 'Adsız bilgisayar'}</span>
                      {tunnel ? (
                        <span className="host-tunnel-tag">
                          <GlobeIcon size={10} />
                          <span>Tünel</span>
                        </span>
                      ) : null}
                    </span>
                    <span className="host-row-sub mono">
                      {tunnel
                        ? tunnel.replace(/^wss:\/\//, '')
                        : `${host.addresses[0] ?? 'yerel'}:${host.port}`}
                    </span>
                  </span>
                  {isActive ? (
                    <span
                      className={`host-active-badge ${
                        connected ? 'is-ok' : failed ? 'is-err' : 'is-warn'
                      }`}
                    >
                      <CheckIcon size={12} />
                      <span>{connected ? 'Bağlı' : failed ? 'Ulaşılamadı' : 'Bağlanıyor'}</span>
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
              ? 'Aktif bilgisayar kapalıysa Sovra otomatik olarak açık diğer bilgisayara geçer.'
              : 'İkinci bilgisayarını (Mac / Huawei) ekleyerek otomatik geçişi açabilirsin.'}
          </p>

          <button
            type="button"
            className="btn btn-secondary full"
            onClick={() => {
              props.onClose();
              props.onAddHost();
            }}
          >
            <PlusIcon size={15} />
            <span>Yeni bilgisayar ekle</span>
          </button>
        </div>
      </div>
    </div>
  );
}
