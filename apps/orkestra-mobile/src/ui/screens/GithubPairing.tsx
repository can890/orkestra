import { createAccountPairingStore, type AccountPairingHost } from '@orkestra/wire/remote';
import { useEffect, useRef, useState } from 'react';
import {
  discoverHosts,
  pairWithHost,
  PAIRING_WAIT_MS,
  type PairResult,
} from '@/core/account-pairing-flow';
import type { AppSession } from '@/core/app-session';
import { githubClientId } from '@/core/github-config';
import {
  describeDeviceCodeFailure,
  describeTokenFailure,
  pollForToken,
  requestDeviceCode,
} from '@/core/github-device-flow';
import { capacitorDeviceFlowHttp } from '@/core/github-http';
import { ErrorNote } from '../components';

const NOT_CONFIGURED = 'Bu sürümde GitHub ile giriş yapılandırılmamış. QR ile eşleştirin.';

type Phase =
  | { name: 'idle' }
  | { name: 'starting' }
  | { name: 'code'; userCode: string; verificationUri: string }
  | { name: 'discovering' }
  | { name: 'choose'; hosts: AccountPairingHost[] }
  | { name: 'waiting-host'; hostName: string }
  | { name: 'error'; message: string };

/** Yalnızca https://github.com adresleri dış tarayıcıda açılır. */
function openExternal(uri: string): void {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return;
    // Android WebView'de sayfa dışı adresler Capacitor köprüsünce ACTION_VIEW ile dış tarayıcıya gider.
    window.open(url.toString(), '_blank');
  } catch {
    // Geçersiz adres: açılmaz.
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * "GitHub ile giriş yap" akışı. Erişim belirteci ve özel anahtar yalnızca bu bileşenin bellek
 * değişkenlerinde (`ref`) yaşar; ne depoya ne günlüğe yazılır, akış bitince ya da iptalde atılır.
 */
export function GithubPairing(props: { session: AppSession }) {
  const clientId = githubClientId();
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const flow = useRef<{
    store: ReturnType<typeof createAccountPairingStore>;
    gistId: string;
  } | null>(null);

  useEffect(
    () => () => {
      abort.current?.abort();
      flow.current = null;
    },
    []
  );

  function reset(next: Phase): void {
    abort.current?.abort();
    abort.current = null;
    flow.current = null;
    setPhase(next);
  }

  async function start(): Promise<void> {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const { signal } = controller;
    setCopied(false);
    setPhase({ name: 'starting' });

    const code = await requestDeviceCode({ clientId, http: capacitorDeviceFlowHttp, signal });
    if (signal.aborted) return;
    if (!code.ok)
      return setPhase({ name: 'error', message: describeDeviceCodeFailure(code.reason) });
    setPhase({
      name: 'code',
      userCode: code.code.userCode,
      verificationUri: code.code.verificationUri,
    });

    const token = await pollForToken({
      clientId,
      code: code.code,
      http: capacitorDeviceFlowHttp,
      sleep: sleepUntilAbort,
      now: Date.now,
      signal,
    });
    if (signal.aborted) return;
    if (!token.ok) return setPhase({ name: 'error', message: describeTokenFailure(token.reason) });

    // Belirteç yalnızca bu kapanışta yaşar.
    const accessToken = token.token;
    const store = createAccountPairingStore({ getToken: () => accessToken });
    setPhase({ name: 'discovering' });
    const found = await discoverHosts(store);
    if (signal.aborted) return;
    if (found.kind !== 'ready') return setPhase({ name: 'error', message: found.message });
    flow.current = { store, gistId: found.gistId };
    if (found.hosts.length === 1) return void connect(found.hosts[0]!, signal);
    setPhase({ name: 'choose', hosts: found.hosts });
  }

  async function connect(host: AccountPairingHost, signal: AbortSignal): Promise<void> {
    const current = flow.current;
    if (!current) return;
    setPhase({ name: 'waiting-host', hostName: host.name });
    const result: PairResult = await pairWithHost({
      store: current.store,
      gistId: current.gistId,
      host,
      pair: (payload) => props.session.pair(payload),
      deviceName: 'Android telefon',
      platform: 'android',
      signal,
    });
    if (signal.aborted) return;
    flow.current = null;
    if (result.kind === 'paired') return;
    if (result.kind === 'cancelled') return setPhase({ name: 'idle' });
    setPhase({ name: 'error', message: result.message });
  }

  function pick(host: AccountPairingHost): void {
    const controller = abort.current;
    if (controller) void connect(host, controller.signal);
  }

  if (!clientId) {
    return (
      <>
        <button className="button primary" disabled>
          GitHub ile giriş yap
        </button>
        <p className="hint">{NOT_CONFIGURED}</p>
      </>
    );
  }

  switch (phase.name) {
    case 'idle':
      return (
        <button className="button primary" onClick={() => void start()}>
          GitHub ile giriş yap
        </button>
      );
    case 'starting':
      return <p className="empty">GitHub ile bağlantı kuruluyor…</p>;
    case 'code':
      return (
        <div>
          <p className="label">github.com/login/device adresini açıp bu kodu girin</p>
          <p className="mono" style={{ fontSize: 28, letterSpacing: 4, textAlign: 'center' }}>
            {phase.userCode}
          </p>
          <button className="button" onClick={() => void copyText(phase.userCode).then(setCopied)}>
            {copied ? 'Kopyalandı' : 'Kodu kopyala'}
          </button>
          <button className="button primary" onClick={() => openExternal(phase.verificationUri)}>
            GitHub&apos;ı aç
          </button>
          <p className="empty">GitHub onayı bekleniyor…</p>
          <button className="button" onClick={() => reset({ name: 'idle' })}>
            Vazgeç
          </button>
        </div>
      );
    case 'discovering':
      return <p className="empty">Hesabınızdaki bilgisayarlar aranıyor…</p>;
    case 'choose':
      return (
        <div>
          <p className="label">Hangi bilgisayarla eşleşilsin?</p>
          {phase.hosts.map((host) => (
            <button key={host.id} className="button" onClick={() => pick(host)}>
              {host.name} · {host.addresses[0]}
            </button>
          ))}
          <button className="button" onClick={() => reset({ name: 'idle' })}>
            Vazgeç
          </button>
        </div>
      );
    case 'waiting-host':
      return (
        <div>
          <p className="empty">
            Bilgisayar bekleniyor… (en çok {Math.round(PAIRING_WAIT_MS / 60_000)} dakika)
          </p>
          <p className="hint">{phase.hostName}</p>
          <button className="button" onClick={() => reset({ name: 'idle' })}>
            Vazgeç
          </button>
        </div>
      );
    case 'error':
      return (
        <div>
          <ErrorNote message={phase.message} />
          <button className="button primary" onClick={() => void start()}>
            Yeniden dene
          </button>
        </div>
      );
  }
}

function sleepUntilAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
