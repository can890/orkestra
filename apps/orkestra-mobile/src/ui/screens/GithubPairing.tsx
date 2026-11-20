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
import { ErrorNote, Loading } from '../components';
import { CheckIcon, CopyIcon, ExternalLinkIcon, GithubIcon, LaptopIcon } from '../icons';

const NOT_CONFIGURED = 'Bu sürümde GitHub ile giriş yapılandırılmamış. QR Kod sekmesini kullanın.';

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
      <div className="gh-stack">
        <button type="button" className="btn btn-primary full" disabled>
          <GithubIcon size={16} />
          <span>GitHub ile bağlan</span>
        </button>
        <p className="muted-note">{NOT_CONFIGURED}</p>
      </div>
    );
  }

  switch (phase.name) {
    case 'idle':
      return (
        <button type="button" className="btn btn-primary full" onClick={() => void start()}>
          <GithubIcon size={16} />
          <span>GitHub ile bağlan</span>
        </button>
      );
    case 'starting':
      return <Loading label="GitHub bağlantısı kuruluyor…" />;
    case 'code':
      return (
        <div className="gh-stack">
          <p className="field-label">GitHub cihaz doğrulama kodu</p>
          <div className="gh-code-box mono">{phase.userCode}</div>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-secondary flex1"
              onClick={() => void copyText(phase.userCode).then(setCopied)}
            >
              {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
              <span>{copied ? 'Kopyalandı' : 'Kopyala'}</span>
            </button>
            <button
              type="button"
              className="btn btn-primary flex1"
              onClick={() => openExternal(phase.verificationUri)}
            >
              <ExternalLinkIcon size={15} />
              <span>GitHub&apos;ı aç</span>
            </button>
          </div>
          <Loading label="Onay bekleniyor…" />
          <button
            type="button"
            className="btn btn-ghost full"
            onClick={() => reset({ name: 'idle' })}
          >
            Vazgeç
          </button>
        </div>
      );
    case 'discovering':
      return <Loading label="Hesabınızdaki Mac bilgisayarlar aranıyor…" />;
    case 'choose':
      return (
        <div className="gh-stack">
          <p className="field-label">Hangi bilgisayara bağlanılsın?</p>
          <div className="surface-group">
            {phase.hosts.map((host) => (
              <button
                key={host.id}
                type="button"
                className="surface-row"
                onClick={() => pick(host)}
              >
                <span className="row-leading">
                  <LaptopIcon size={16} className="icon-accent" />
                </span>
                <span className="row-main">
                  <span className="row-title">{host.name}</span>
                  <span className="row-sub mono">{host.addresses[0]}</span>
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-ghost full"
            onClick={() => reset({ name: 'idle' })}
          >
            Vazgeç
          </button>
        </div>
      );
    case 'waiting-host':
      return (
        <div className="gh-stack">
          <Loading
            label={`${phase.hostName} onayı bekleniyor… (en çok ${Math.round(PAIRING_WAIT_MS / 60_000)} dk)`}
          />
          <button
            type="button"
            className="btn btn-ghost full"
            onClick={() => reset({ name: 'idle' })}
          >
            Vazgeç
          </button>
        </div>
      );
    case 'error':
      return (
        <div className="gh-stack">
          <ErrorNote message={phase.message} />
          <button type="button" className="btn btn-primary full" onClick={() => void start()}>
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
