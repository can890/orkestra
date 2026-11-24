import { autorun } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { browserAgentActivity } from '@core/features/browser/api/browser/browser-agent-activity';
import { browserControlsRegistry } from '@core/features/browser/api/browser/browser-controls-registry';
import { browserRightPanelStore } from '@core/features/browser/api/browser/browser-right-panel-store';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import {
  browserWebviewHost,
  type BrowserDropHighlight,
  type BrowserWebviewPlacement,
  type BrowserWebviewRect,
} from '@core/features/browser/api/browser/browser-webview-host';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import { BROWSER_DEFAULT_URL } from '@core/primitives/browser/api';
import { AgentBrowserCursor } from './agent-browser-cursor';
import { bindBrowserWebviewEvents } from './browser-webview-events';
import {
  createBrowserWebviewAdapter,
  type BrowserWebviewAdapter,
  type BrowserWebviewElement,
} from './browser-webview-types';

const WEBVIEW_ALLOW_POPUPS_ATTRIBUTE = 'true' as unknown as boolean;

/**
 * Katmanın yığın sırası: görev içeriğinin üstünde, açılır menü/diyalog/ipucu (z-50) ve
 * bildirimlerin altında.
 */
export const BROWSER_WEBVIEW_LAYER_Z_INDEX = 40;

type WebviewMount = {
  partition: string;
  src: string;
  revision: number;
};

type CrashState = 'live' | 'crashed';

/**
 * Tüm açık tarayıcı oturumlarının webview'lerini barındıran, uygulama düzeyindeki kalıcı katman.
 *
 * Katman kökü `display: contents` kullanır; böylece ayrı bir CSS stacking context oluşturmaz.
 * Her webview sunucusu (`[data-browser-webview-host]`) kendi `position: fixed` katmanında yaşar ve
 * yerleştirildiği yuvanın `zIndex` değerini alır (sağ panel ~30, mini pencere ~48, kenar/köşe
 * tutamaçları ~49, uygulama diyalogları 50+).
 */
export const BrowserWebviewLayer = observer(function BrowserWebviewLayer() {
  const browserIds = Array.from(browserSessionStore.sessions.keys()).sort();
  return (
    <div data-browser-webview-layer="" style={LAYER_STYLE}>
      {browserIds.map((browserId) => (
        <BrowserWebviewEntry key={browserId} browserId={browserId} />
      ))}
    </div>
  );
});

const BrowserWebviewEntry = observer(function BrowserWebviewEntry({
  browserId,
}: {
  browserId: string;
}) {
  const session = browserSessionStore.getSession(browserId);
  const partition = session?.partition;
  const projectId = session?.projectId;
  const workspaceId = session?.workspaceId;
  const taskId = session?.taskId;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<BrowserWebviewElement | null>(null);
  const [webviewElement, setWebviewElement] = useState<BrowserWebviewElement | null>(null);
  const [adapter, setAdapter] = useState<BrowserWebviewAdapter | null>(null);
  const adapterRef = useRef<BrowserWebviewAdapter | null>(null);
  adapterRef.current = adapter;
  const [isRegistered, setIsRegistered] = useState(false);
  const [webviewMount, setWebviewMount] = useState<WebviewMount | null>(null);
  const [crashState, setCrashState] = useState<CrashState>('live');
  const crashAutoReloadCountRef = useRef(0);

  // Ana süreç, kayıtlı bölümlere (partition) ait olmayan webview'leri kapatır; webview yalnızca
  // oturum kaydı tamamlanınca çizilir. Kimlik ve son adres ajan sorguları içindir.
  useEffect(() => {
    if (!partition) return;
    let disposed = false;
    setIsRegistered(false);
    const snapshot = browserSessionStore.getSnapshot(browserId);
    void getBrowserClient()
      .then((client) =>
        client.registerSession({
          browserId,
          partition,
          projectId,
          workspaceId,
          taskId,
          url: snapshot?.currentUrl,
          title: snapshot?.title,
        })
      )
      .then((result) => {
        if (!disposed) setIsRegistered(result.success);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      setIsRegistered(false);
    };
  }, [browserId, partition, projectId, workspaceId, taskId]);

  useEffect(() => {
    browserWebviewHost.setRegistered(browserId, isRegistered);
  }, [browserId, isRegistered]);

  useEffect(() => () => browserWebviewHost.setRegistered(browserId, false), [browserId]);

  useEffect(() => {
    if (!partition) {
      setWebviewMount(null);
      return;
    }
    setWebviewMount((current) => {
      if (current?.partition === partition) return current;
      return {
        partition,
        src: browserSessionStore.getSession(browserId)?.currentUrl ?? BROWSER_DEFAULT_URL,
        revision: 0,
      };
    });
  }, [browserId, partition]);

  // Sekmeden gelen adres yüklemeleri: webview hazırsa doğrudan, değilse yeni kaynakla yeniden bağla.
  useEffect(
    () =>
      browserWebviewHost.attachLoader(browserId, (url) => {
        const currentAdapter = adapterRef.current;
        if (currentAdapter) {
          void currentAdapter.loadUrl(url).catch(() => {});
          return;
        }
        setWebviewMount((current) =>
          current ? { ...current, src: url, revision: current.revision + 1 } : current
        );
      }),
    [browserId]
  );

  // Referansı sabit kalmalı: React satır içi ref geri çağrılarını her çizimde null + düğümle
  // yeniden çağırır; bu, bir sonraki dom-ready'ye kadar adaptörü silip yakınlaştırma, durdurma ve
  // zorla yenileme gibi adaptöre bağlı her şeyi bozardı.
  const attachWebview = useCallback((node: Element | null) => {
    const next = node as BrowserWebviewElement | null;
    if (webviewRef.current === next) return;
    webviewRef.current = next;
    setWebviewElement(next);
    setAdapter(null);
  }, []);

  useEffect(() => {
    if (!webviewElement) return;
    // Sekmeler aynı profil bölümünü paylaşabildiği için ana süreç webview'in hangi sekmeye ait
    // olduğunu çıkaramaz; açıkça bağlanır. Konuk eklenir eklenmez bağlamak, ajanların sayfayı ilk
    // yükleme bitmeden kontrol edebilmesini sağlar (dom-ready'de yeniden denenir).
    const bind = () => {
      if (webviewRef.current !== webviewElement) return;
      let webContentsId: number;
      try {
        webContentsId = webviewElement.getWebContentsId();
      } catch {
        return;
      }
      void getBrowserClient()
        .then((client) => client.bindWebContents({ browserId, webContentsId }))
        .catch(() => {});
    };
    const cleanupEvents = bindBrowserWebviewEvents(browserId, webviewElement, {
      onAttach: bind,
      onDomReady: () => {
        if (webviewRef.current !== webviewElement) return;
        setCrashState('live');
        bind();
        setAdapter((current) => current ?? createBrowserWebviewAdapter(webviewElement));
      },
    });

    const onIpcMessage = (rawEvent: Event) => {
      const event = rawEvent as Event & { channel?: string; args?: unknown[] };
      if (event.channel === 'browser:pointer-down') {
        void getBrowserClient()
          .then((client) => client.setActiveBrowser({ browserId }))
          .catch(() => {});
        browserRightPanelStore.activateTabById(browserId);
      } else if (event.channel === 'browser:thumb-nav') {
        const direction = event.args?.[0];
        if (direction === 'back' && adapterRef.current?.canGoBack()) {
          adapterRef.current.goBack();
        } else if (direction === 'forward' && adapterRef.current?.canGoForward()) {
          adapterRef.current.goForward();
        }
      }
    };

    const onRenderProcessGone = (rawEvent: Event) => {
      const event = rawEvent as Event & { details?: { reason?: string }; reason?: string };
      const reason = event.details?.reason ?? event.reason ?? 'crashed';
      if (reason === 'clean-exit') return;
      if (crashAutoReloadCountRef.current < 1) {
        crashAutoReloadCountRef.current += 1;
        setWebviewMount((current) =>
          current ? { ...current, revision: current.revision + 1 } : current
        );
        return;
      }
      setCrashState('crashed');
    };

    webviewElement.addEventListener('ipc-message', onIpcMessage);
    webviewElement.addEventListener('render-process-gone', onRenderProcessGone);
    return () => {
      webviewElement.removeEventListener('ipc-message', onIpcMessage);
      webviewElement.removeEventListener('render-process-gone', onRenderProcessGone);
      cleanupEvents();
    };
  }, [browserId, webviewElement]);

  useEffect(() => {
    if (!adapter) return;
    return browserControlsRegistry.registerAdapter(browserId, adapter);
  }, [adapter, browserId]);

  // Konum ve görünürlük doğrudan DOM'a yazılır: yer tutucu ölçümü aynı karede uygulanır.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return autorun(() => {
      const currentSession = browserSessionStore.getSession(browserId);
      applyPlacement(
        host,
        browserWebviewHost.placement(browserId),
        browserAgentActivity.isActive(browserId) || Boolean(currentSession?.pictureInPicture)
      );
    });
  }, [browserId]);

  const webviewProps = useMemo(() => {
    if (!webviewMount) return null;
    return {
      src: webviewMount.src,
      partition: webviewMount.partition,
      allowpopups: WEBVIEW_ALLOW_POPUPS_ATTRIBUTE,
      'data-browser-id': browserId,
    };
  }, [browserId, webviewMount]);

  return (
    <div ref={hostRef} data-browser-webview-host={browserId} style={HIDDEN_HOST_STYLE}>
      <div className="emlight relative bg-background" style={FILL_STYLE}>
        {webviewProps && isRegistered ? (
          <webview
            key={`${browserId}:${webviewMount?.partition ?? 'partition'}:${webviewMount?.revision ?? 0}`}
            ref={attachWebview}
            {...webviewProps}
            className="bg-background"
            style={FILL_STYLE}
          />
        ) : null}
        {crashState === 'crashed' ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-neutral-950/90 p-4 text-center text-xs text-neutral-200">
            <p className="font-medium">Sayfa işlemi beklenmedik şekilde sonlandı.</p>
            <button
              type="button"
              className="rounded-md border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/20"
              onClick={() => {
                crashAutoReloadCountRef.current = 0;
                setCrashState('live');
                setWebviewMount((current) =>
                  current ? { ...current, revision: current.revision + 1 } : current
                );
              }}
            >
              Sayfayı yeniden yükle
            </button>
          </div>
        ) : null}
      </div>
      <AgentBrowserCursor browserId={browserId} />
      <BrowserDropHighlightOverlay browserId={browserId} />
    </div>
  );
});

/**
 * Sekme sürüklenirken bölmenin bırakma vurgusu webview'in altında kalırdı; aynısını webview'in
 * üstünde, katmanda çizer.
 */
const BrowserDropHighlightOverlay = observer(function BrowserDropHighlightOverlay({
  browserId,
}: {
  browserId: string;
}) {
  const placement = browserWebviewHost.placement(browserId);
  if (!placement.visible || !placement.highlight || !placement.region) return null;
  const area = highlightArea(placement.highlight, placement.region);
  return (
    <div
      data-browser-drop-highlight={placement.highlight}
      className="bg-foreground/10"
      style={{
        position: 'absolute',
        pointerEvents: 'none',
        left: area.left - placement.rect.left,
        top: area.top - placement.rect.top,
        width: area.width,
        height: area.height,
      }}
    />
  );
});

// Katman kökünde CSS stacking context oluşmasın diye display:contents kullanılır.
const LAYER_STYLE = {
  display: 'contents',
} as const;

const HIDDEN_HOST_STYLE = {
  position: 'fixed',
  overflow: 'hidden',
  left: 0,
  top: 0,
  width: 0,
  height: 0,
  visibility: 'hidden',
  pointerEvents: 'none',
  zIndex: 0,
} as const;

const FILL_STYLE = { display: 'flex', width: '100%', height: '100%' } as const;

function applyPlacement(
  host: HTMLDivElement,
  placement: BrowserWebviewPlacement,
  paintInBackground: boolean
): void {
  const { rect, visible } = placement;
  host.style.left = `${rect.left}px`;
  host.style.top = `${rect.top}px`;
  host.style.width = `${rect.width}px`;
  host.style.height = `${rect.height}px`;
  // visibility:hidden sayfanın çizimini durdurur ve ekran görüntüsü alınamaz; ajanın kullandığı
  // veya PiP penceresine akan gizli sekme bu yüzden görünmez ama çizilmeye devam eder.
  const paintHidden = !visible && paintInBackground;
  host.style.visibility = visible || paintHidden ? 'visible' : 'hidden';
  host.style.opacity = paintHidden ? '0' : '';
  host.style.pointerEvents = visible && placement.interactive ? 'auto' : 'none';
  host.style.zIndex = visible ? String(placement.zIndex || 30) : '0';
  host.style.borderRadius = placement.cornerRadius > 0 ? `${placement.cornerRadius}px` : '';
  host.inert = !visible;
  // Webview'e odaklanmak, sahibi olan bölmenin view-scope'unu etkinleştirmeli (kısayollar).
  if (visible && placement.scopeId) host.setAttribute('data-view-scope', placement.scopeId);
  else host.removeAttribute('data-view-scope');
}

function highlightArea(kind: BrowserDropHighlight, region: BrowserWebviewRect): BrowserWebviewRect {
  const halfWidth = region.width / 2;
  const halfHeight = region.height / 2;
  switch (kind) {
    case 'full':
      return region;
    case 'left':
      return { ...region, width: halfWidth };
    case 'right':
      return { ...region, left: region.left + halfWidth, width: halfWidth };
    case 'top':
      return { ...region, height: halfHeight };
    case 'bottom':
      return { ...region, top: region.top + halfHeight, height: halfHeight };
  }
}
