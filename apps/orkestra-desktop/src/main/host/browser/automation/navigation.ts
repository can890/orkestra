import type { WebContents } from 'electron';
import { normalizeBrowserUrl } from '@core/primitives/browser/api';

/** Chromium ERR_ABORTED: başka bir gezinme (ör. istemci yönlendirmesi) öncekinin yerini aldı. */
export const ERR_ABORTED = -3;

/**
 * Ajanın verdiği adresi doğrular ve normalleştirir. İzinli şemalar: http:, https:, file: ve
 * yalnızca about:blank. "localhost:3000" gibi şemasız adresler http(s) ile tamamlanır;
 * javascript:, data:, chrome:, devtools: vb. reddedilir.
 */
export function resolveNavigationUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('Missing URL; pass an absolute http(s) URL such as https://example.com.');
  }
  const normalized = normalizeBrowserUrl(raw, { allowSearchQueries: false, allowFileUrls: true });
  if (normalized.ok) return normalized.url;
  if (
    normalized.reason === 'unsupported-protocol' ||
    normalized.reason === 'unsupported-file-url'
  ) {
    const scheme = /^([a-z][a-z\d+.-]*):/i.exec(raw.trim())?.[1]?.toLowerCase();
    throw new Error(
      `Unsupported URL scheme${scheme ? ` "${scheme}:"` : ''} in ${JSON.stringify(raw)}; ` +
        'only http:, https:, file: and about:blank are allowed.'
    );
  }
  throw new Error(
    `Invalid URL ${JSON.stringify(raw)}; pass an absolute URL such as https://example.com.`
  );
}

export type NavigationOutcome =
  | { kind: 'settled' }
  | { kind: 'failed'; errorCode: number; errorDescription: string; url: string }
  | { kind: 'timeout' }
  | { kind: 'destroyed' }
  | { kind: 'crashed'; reason: string };

export type NavigationWatch = {
  readonly outcome: Promise<NavigationOutcome>;
  /** Ana çerçevede hiç gezinme başlamazsa `idleMs` sonra "settled" ile çözülür. */
  armIdle(idleMs: number): void;
  dispose(): void;
};

type StartNavigationDetails = { isMainFrame?: unknown; isSameDocument?: unknown };

/**
 * Ana çerçeve gezinmesinin oturmasını olaylarla izler; başarısız yüklemelerde asla askıda
 * kalmaz. Oturma: gezinme başladıktan sonra `did-finish-load`, `did-stop-loading` ya da
 * sayfa içi gezinme. Ana çerçevede ERR_ABORTED dışındaki `did-fail-load` hata sonucudur.
 * Alt çerçevelerin yüklemeleri (reklam iframe'leri vb.) dikkate alınmaz.
 */
export function watchNavigation(
  webContents: WebContents,
  options: { timeoutMs: number }
): NavigationWatch {
  let finished = false;
  let activity = false;
  let failure: { errorCode: number; errorDescription: string; url: string } | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveOutcome: (outcome: NavigationOutcome) => void = () => undefined;
  const outcome = new Promise<NavigationOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  const finish = (result: NavigationOutcome) => {
    if (finished) return;
    finished = true;
    cleanup();
    resolveOutcome(result);
  };
  const settle = () => finish(failure ? { kind: 'failed', ...failure } : { kind: 'settled' });

  const onStartNavigation = (
    details: StartNavigationDetails,
    _url?: string,
    isInPlace?: boolean,
    isMainFrame?: boolean
  ) => {
    const mainFrame = typeof details?.isMainFrame === 'boolean' ? details.isMainFrame : isMainFrame;
    const sameDocument =
      typeof details?.isSameDocument === 'boolean' ? details.isSameDocument : isInPlace;
    if (!mainFrame) return;
    activity = true;
    if (!sameDocument) failure = null;
  };
  const onNavigate = () => {
    activity = true;
    failure = null;
  };
  const onNavigateInPage = (_event: unknown, _url: string, isMainFrame: boolean) => {
    if (!isMainFrame) return;
    activity = true;
    setTimeout(() => {
      if (!finished && !webContents.isDestroyed() && !webContents.isLoadingMainFrame()) settle();
    }, 0);
  };
  const onFinishLoad = () => {
    if (activity) settle();
  };
  const onStopLoading = () => {
    if (activity) settle();
  };
  const onFailLoad = (
    _event: unknown,
    errorCode: number,
    errorDescription: string,
    validatedUrl: string,
    isMainFrame: boolean
  ) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return;
    activity = true;
    failure = { errorCode, errorDescription, url: validatedUrl };
    settle();
  };
  const onDestroyed = () => finish({ kind: 'destroyed' });
  const onGone = (_event: unknown, details: { reason?: string }) =>
    finish({ kind: 'crashed', reason: details?.reason ?? 'unknown' });

  webContents.on('did-start-navigation', onStartNavigation);
  webContents.on('did-navigate', onNavigate);
  webContents.on('did-navigate-in-page', onNavigateInPage);
  webContents.on('did-finish-load', onFinishLoad);
  webContents.on('did-stop-loading', onStopLoading);
  webContents.on('did-fail-load', onFailLoad);
  webContents.on('destroyed', onDestroyed);
  webContents.on('render-process-gone', onGone);
  const timeoutTimer = setTimeout(
    () => finish({ kind: 'timeout' }),
    Math.max(0, options.timeoutMs)
  );

  function cleanup(): void {
    clearTimeout(timeoutTimer);
    if (idleTimer) clearTimeout(idleTimer);
    webContents.removeListener('did-start-navigation', onStartNavigation);
    webContents.removeListener('did-navigate', onNavigate);
    webContents.removeListener('did-navigate-in-page', onNavigateInPage);
    webContents.removeListener('did-finish-load', onFinishLoad);
    webContents.removeListener('did-stop-loading', onStopLoading);
    webContents.removeListener('did-fail-load', onFailLoad);
    webContents.removeListener('destroyed', onDestroyed);
    webContents.removeListener('render-process-gone', onGone);
  }

  return {
    outcome,
    armIdle(idleMs: number) {
      if (finished) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => {
          if (activity || finished) return;
          if (webContents.isDestroyed()) {
            finish({ kind: 'destroyed' });
          } else if (webContents.isLoadingMainFrame()) {
            // İzlemeden önce başlamış bir yükleme sürüyor; onun bitmesini bekle.
            activity = true;
          } else {
            settle();
          }
        },
        Math.max(0, idleMs)
      );
    },
    dispose() {
      if (finished) return;
      finished = true;
      cleanup();
      resolveOutcome({ kind: 'settled' });
    },
  };
}
