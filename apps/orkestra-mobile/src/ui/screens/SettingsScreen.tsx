import { useState } from 'react';
import type { AppSession } from '@/core/app-session';
import type { ConnectionManager } from '@/core/connection-manager';
import { describeStatus } from '@/core/connection-state';
import type { PairingRecord } from '@/core/pairing-store';
import { Header } from '../components';
import { useConnectionStatus } from '../hooks';

export function SettingsScreen(props: {
  session: AppSession;
  record: PairingRecord;
  manager: ConnectionManager;
}) {
  const status = useConnectionStatus(props.manager);
  const [confirming, setConfirming] = useState(false);
  return (
    <main className="screen">
      <Header title="Ayarlar" />
      <section className="card">
        <div className="row">
          <strong>Masaüstü</strong>
          <span>{props.record.hostName || 'Adsız'}</span>
        </div>
        <div className="row">
          <strong>Durum</strong>
          <span>{describeStatus(status)}</span>
        </div>
        <div className="row">
          <strong>Adresler</strong>
          <span className="mono small-text">
            {props.record.addresses.map((address) => `${address}:${props.record.port}`).join(', ')}
          </span>
        </div>
      </section>
      <section className="card">
        <p className="hint">
          Eşleşmeyi kaldırınca bu telefondaki anahtar silinir. Masaüstünde de Ayarlar → Mobil erişim
          sayfasından bu cihazı iptal etmeyi unutmayın.
        </p>
        {confirming ? (
          <div className="row">
            <button className="button danger" onClick={() => void props.session.unpair()}>
              Evet, kaldır
            </button>
            <button className="button" onClick={() => setConfirming(false)}>
              Vazgeç
            </button>
          </div>
        ) : (
          <button className="button danger" onClick={() => setConfirming(true)}>
            Eşleşmeyi kaldır
          </button>
        )}
      </section>
    </main>
  );
}
