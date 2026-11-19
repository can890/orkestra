import { useState } from 'react';
import type { AppSession } from '@/core/app-session';
import { describePairingFailure, parsePairingPayload } from '@/core/pairing';
import { ErrorNote, Header } from '../components';
import { scanQrCode } from '../qr-scan';

export function PairingScreen(props: { session: AppSession }) {
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
      setError('Bu cihazda QR tarayıcı kullanılamıyor. Kodu aşağıya yapıştırın.');
    } else if (outcome.reason === 'installing') {
      setError('QR tarayıcı modülü indiriliyor. Birkaç saniye sonra tekrar deneyin.');
    }
  }

  return (
    <main className="screen">
      <Header title="Orkestra'ya bağlan" subtitle="Masaüstündeki Orkestra ile eşleştirin" />
      <section className="card">
        <ol className="steps">
          <li>Masaüstünde Ayarlar → Mobil erişim sayfasını açıp özelliği etkinleştirin.</li>
          <li>&quot;QR kodu oluştur&quot; deyin (kod 10 dakika geçerlidir).</li>
          <li>Telefon ve bilgisayar aynı ağda ya da Tailscale üzerinde olmalıdır.</li>
        </ol>
        <button className="button primary" onClick={() => void scan()} disabled={busy}>
          QR kodu okut
        </button>
      </section>
      <section className="card">
        <label htmlFor="pair-code" className="label">
          Ya da kodu elle yapıştırın
        </label>
        <textarea
          id="pair-code"
          className="textarea mono"
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
          className="button"
          disabled={busy || text.trim() === ''}
          onClick={() => void submit(text)}
        >
          {busy ? 'Bağlanıyor…' : 'Eşleştir'}
        </button>
      </section>
    </main>
  );
}
