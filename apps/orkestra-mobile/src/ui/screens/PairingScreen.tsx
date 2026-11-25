import { useState } from 'react';
import type { AppSession } from '@/core/app-session';
import { githubClientId } from '@/core/github-config';
import { describePairingFailure, parsePairingPayload } from '@/core/pairing';
import { ErrorNote, SovraMark } from '../components';
import { GithubIcon, QrCodeIcon } from '../icons';
import { scanQrCode } from '../qr-scan';
import { GithubPairing } from './GithubPairing';

type PairTab = 'github' | 'qr' | 'manual';

export function PairingScreen(props: {
  session: AppSession;
  onCancel?: () => void;
  onPaired?: () => void;
}) {
  const [tab, setTab] = useState<PairTab>(() => (githubClientId() ? 'github' : 'qr'));
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(raw: string): Promise<void> {
    const parsed = parsePairingPayload(raw);
    if (!parsed.ok) {
      setError(describePairingFailure(parsed.reason));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.session.pair(parsed.payload);
      props.onPaired?.();
    } catch {
      setError('Eşleştirme kaydı cihazın güvenli deposuna yazılamadı.');
      setBusy(false);
    }
  }

  async function scan(): Promise<void> {
    setError(null);
    const outcome = await scanQrCode();
    if (outcome.ok) return submit(outcome.text);
    if (outcome.reason === 'unsupported') {
      setError('Bu cihazda QR tarayıcı kullanılamıyor. "Elle Kod" sekmesini kullanın.');
    } else if (outcome.reason === 'installing') {
      setError('QR tarayıcı modülü indiriliyor. Birkaç saniye sonra tekrar deneyin.');
    }
  }

  return (
    <main className="pairing-screen">
      {props.onCancel ? (
        <div className="pairing-top-bar">
          <button type="button" className="btn btn-ghost btn-sm" onClick={props.onCancel}>
            ← Vazgeç
          </button>
        </div>
      ) : null}
      <div className="pairing-hero">
        <div className="pairing-logo-ring">
          <SovraMark size={48} />
        </div>
        <h1 className="pairing-title">{props.onCancel ? 'Bilgisayar Ekle' : 'Sovra'}</h1>
        <p className="pairing-sub">
          {props.onCancel
            ? 'Mac veya Huawei bilgisayarınızı ekleyin; biri kapalıysa telefon otomatik diğerine geçer.'
            : 'Mac veya Huawei bilgisayarınızdaki Sovra çalışma alanına aynı Wi-Fi gerekmeden her yerden bağlanın.'}
        </p>
      </div>

      <div className="segmented" role="tablist" aria-label="Bağlantı yöntemi">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'github'}
          className={`segmented-btn ${tab === 'github' ? 'is-active' : ''}`}
          onClick={() => setTab('github')}
        >
          <GithubIcon size={14} />
          <span>GitHub</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'qr'}
          className={`segmented-btn ${tab === 'qr' ? 'is-active' : ''}`}
          onClick={() => setTab('qr')}
        >
          <QrCodeIcon size={14} />
          <span>QR Kod</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'manual'}
          className={`segmented-btn ${tab === 'manual' ? 'is-active' : ''}`}
          onClick={() => setTab('manual')}
        >
          <span>Elle Kod</span>
        </button>
      </div>

      {tab === 'github' ? (
        <section className="panel-card pairing-card">
          <GithubPairing session={props.session} />
          <p className="muted-note">
            Bilgisayarınızda (Mac / Huawei){' '}
            <strong>Ayarlar → Mobil erişim → GitHub hesabıyla eşleş</strong> açık olmalıdır.
          </p>
        </section>
      ) : null}

      {tab === 'qr' ? (
        <section className="panel-card pairing-card">
          <ol className="pairing-steps">
            <li>Bilgisayarınızda (Mac / Huawei) Ayarlar → Mobil erişim sayfasını açın.</li>
            <li>&quot;QR kodu oluştur&quot; düğmesine tıklayın (10 dakika geçerlidir).</li>
            <li>
              Aynı Wi-Fi veya otomatik internet tüneli (5G dahil) üzerinden her yerden bağlanır.
            </li>
          </ol>
          <ErrorNote message={error} />
          <button
            type="button"
            className="btn btn-primary full"
            onClick={() => void scan()}
            disabled={busy}
          >
            <QrCodeIcon size={16} />
            <span>{busy ? 'Eşleştiriliyor…' : 'QR kodu tara'}</span>
          </button>
        </section>
      ) : null}

      {tab === 'manual' ? (
        <section className="panel-card pairing-card">
          <label htmlFor="pair-code" className="field-label">
            Masaüstü eşleştirme kodu
          </label>
          <textarea
            id="pair-code"
            className="code-textarea mono"
            rows={5}
            value={text}
            placeholder='{"k":"orkestra-pair", …}'
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
          />
          <ErrorNote message={error} />
          <button
            type="button"
            className="btn btn-primary full"
            disabled={busy || text.trim() === ''}
            onClick={() => void submit(text)}
          >
            {busy ? 'Bağlanıyor…' : 'Eşleştir'}
          </button>
        </section>
      ) : null}
    </main>
  );
}
