import { useDndContext } from '@dnd-kit/core';
import { Button } from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { browserAgentActivity } from '@core/features/browser/api/browser/browser-agent-activity';
import { browserControlsRegistry } from '@core/features/browser/api/browser/browser-controls-registry';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import {
  browserWebviewHost,
  type BrowserDropHighlight,
} from '@core/features/browser/api/browser/browser-webview-host';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import { usePreviewServers } from '@core/features/workbench/api/browser/task-composition-context';
import {
  cycleNextTabCommand,
  cyclePreviousTabCommand,
} from '@core/features/workbench/contributions/commands';
import {
  BROWSER_DEFAULT_URL,
  normalizeBrowserUrl,
  normalizeBrowserZoomFactor,
} from '@core/primitives/browser/api';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';
import { parsePaneDropTargetId } from '@core/primitives/workbench-shell/browser/tabs/pane-drop-target';
import {
  browserLoadErrorCode,
  describeBrowserLoadError,
  type BrowserLoadErrorPresentation,
} from './browser-load-error';
import { decideBrowserReload } from './browser-navigation-controls';
import { BrowserStartPage } from './browser-start-page';
import { BrowserToolbar } from './browser-toolbar';
import { canOpenBrowserUrlExternally, openBrowserUrlExternally } from './browser-toolbar-actions';
import { useBrowserWebviewSlot } from './browser-webview-slot';

/**
 * The browser tab body: toolbar plus a placeholder for the page. The page's
 * webview lives in the persistent BrowserWebviewLayer so it survives task
 * switches; while this tab is visible the placeholder claims its bounds and
 * the layer positions the webview over it.
 */
export const BrowserPane = observer(function BrowserPane({
  browserId,
  visible,
}: {
  browserId: string;
  visible: boolean;
}) {
  const session = browserSessionStore.getSession(browserId);
  const { paneId, scopeInstance } = usePaneContext();
  const { active: activeDrag, over } = useDndContext();
  const previewServers = usePreviewServers();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const focusUrlRef = useRef<() => void>(() => {});
  const adapter = browserControlsRegistry.getAdapter(browserId);
  const isRegistered = browserWebviewHost.isRegistered(browserId);
  const isAgentTab = browserAgentActivity.isAgentOpened(browserId);
  const sessionBrowserId = session?.browserId;
  // The page stays mounted behind the start page, so a blank page loading must
  // not flash it; navigating away replaces currentUrl immediately.
  const showStartPage = session?.currentUrl === BROWSER_DEFAULT_URL;
  const loadError = session && !session.isLoading ? session.loadError : undefined;
  const loadErrorUrl = loadError ? (loadError.url ?? session?.currentUrl ?? '') : '';
  const loadErrorPresentation = useMemo<BrowserLoadErrorPresentation | undefined>(
    () => (loadError ? describeBrowserLoadError(loadError, loadErrorUrl) : undefined),
    [loadError, loadErrorUrl]
  );
  const canOpenLoadErrorExternal = useMemo(
    () => (loadError ? canOpenBrowserUrlExternally(loadErrorUrl) : false),
    [loadError, loadErrorUrl]
  );
  const showLoadError = !!loadError && !!loadErrorPresentation;
  const showWebview = visible && !!session && !showStartPage && !showLoadError;
  const overId = over ? String(over.id) : undefined;

  useBrowserWebviewSlot({
    browserId,
    placeholderRef,
    regionRef: rootRef,
    show: showWebview,
    // dnd-kit tracks the pointer on this document; the page must not swallow it mid-drag.
    interactive: !activeDrag,
    scopeId: scopeInstance?.id,
    highlight: activeDrag ? dropHighlightFor(overId, paneId) : null,
  });

  useEffect(() => {
    return () => {
      void getBrowserClient().then((client) => client.setActiveBrowser({ browserId: null }));
    };
  }, []);

  useEffect(() => {
    if (!visible || !sessionBrowserId || adapter === null) return;
    void getBrowserClient().then((client) =>
      client.setActiveBrowser({ browserId: sessionBrowserId })
    );
  }, [adapter, sessionBrowserId, visible]);

  useEffect(() => {
    if (!visible || !sessionBrowserId) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void getHostClient().then(async (client) => {
      const nextUnsubscribe = await client.events.subscribe(undefined, {
        onEvent: (event) => {
          if (
            event.type !== 'tab-navigation-shortcut' ||
            event.source.browserId !== sessionBrowserId
          ) {
            return;
          }
          const command =
            event.direction === 'next' ? cycleNextTabCommand : cyclePreviousTabCommand;
          void scopeInstance?.getCommand(command)?.execute(undefined, 'keybinding');
        },
        onGap: () => {},
      });
      if (disposed) nextUnsubscribe();
      else unsubscribe = nextUnsubscribe;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [sessionBrowserId, scopeInstance, visible]);

  const loadUrl = useCallback(
    (url: string) => {
      if (!sessionBrowserId) return;
      browserSessionStore.updateSession(sessionBrowserId, {
        currentUrl: url,
        faviconUrl: null,
        isLoading: true,
        loadError: null,
      });
      browserWebviewHost.load(sessionBrowserId, url);
    },
    [sessionBrowserId]
  );

  const navigateTo = useCallback(
    (url: string): boolean => {
      const normalized = normalizeBrowserUrl(url);
      if (!normalized.ok) return false;
      loadUrl(normalized.url);
      return true;
    },
    [loadUrl]
  );

  const goBack = useCallback(() => {
    if (!adapter?.canGoBack()) return;
    adapter.goBack();
  }, [adapter]);

  const goForward = useCallback(() => {
    if (!adapter?.canGoForward()) return;
    adapter.goForward();
  }, [adapter]);

  const reload = useCallback(() => {
    if (!session) return;
    const decision = decideBrowserReload({
      currentUrl: session.currentUrl,
      isLoading: session.isLoading,
      hasAdapter: adapter !== null,
    });
    if (decision.kind === 'reload-adapter') adapter?.reload();
    if (decision.kind === 'stop-adapter') adapter?.stop();
    if (decision.kind === 'retry-url') loadUrl(decision.url);
  }, [adapter, loadUrl, session]);

  const forceReload = useCallback(() => {
    if (adapter) {
      adapter.reloadIgnoringCache();
      return;
    }
    reload();
  }, [adapter, reload]);

  const setZoomFactor = useCallback(
    (factor: number) => {
      if (!sessionBrowserId) return;
      const zoomFactor = normalizeBrowserZoomFactor(factor);
      browserSessionStore.updateSession(sessionBrowserId, {
        zoomFactor,
      });
      adapter?.setZoomFactor(zoomFactor);
    },
    [adapter, sessionBrowserId]
  );

  useEffect(() => {
    if (!sessionBrowserId) return;
    return browserControlsRegistry.registerUrlFocuser(sessionBrowserId, () =>
      focusUrlRef.current()
    );
  }, [sessionBrowserId]);

  if (!session) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-background text-sm text-foreground-muted">
        Browser session unavailable
      </div>
    );
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-background">
      <BrowserToolbar
        session={session}
        adapter={adapter}
        // Agent-opened tabs must not pull keyboard focus away from the user.
        autoFocusUrl={showStartPage && !isAgentTab}
        onNavigate={navigateTo}
        onGoBack={goBack}
        onGoForward={goForward}
        onReload={reload}
        onForceReload={forceReload}
        onSetZoomFactor={setZoomFactor}
        onFocusUrl={(focus) => {
          focusUrlRef.current = focus;
        }}
      />
      <div className="emlight relative min-h-0 flex-1 bg-background">
        {/* The layer positions this tab's webview over the placeholder; focusing
            it (pane focus restoration) forwards focus into the page. */}
        <div
          ref={placeholderRef}
          data-browser-webview-placeholder={browserId}
          data-pane-focus-proxy={showWebview ? '' : undefined}
          tabIndex={showWebview ? -1 : undefined}
          className="absolute inset-0 outline-none"
          onFocus={() => adapter?.focus()}
        />
        {showLoadError && loadErrorPresentation ? (
          <BrowserLoadErrorView
            url={loadErrorUrl}
            presentation={loadErrorPresentation}
            code={browserLoadErrorCode(loadError)}
            canOpenExternal={canOpenLoadErrorExternal}
            onReload={reload}
            onOpenExternal={() => openBrowserUrlExternally(loadErrorUrl)}
          />
        ) : showStartPage ? (
          <BrowserStartPage devServerUrls={previewServers.urls} onOpenUrl={navigateTo} />
        ) : !isRegistered ? (
          <div className="flex h-full items-center justify-center text-sm text-foreground-muted">
            Preparing browser session
          </div>
        ) : null}
      </div>
    </div>
  );
});

function dropHighlightFor(overId: string | undefined, paneId: string): BrowserDropHighlight | null {
  if (!overId) return null;
  const target = parsePaneDropTargetId(overId);
  if (!target || target.paneId !== paneId) return null;
  if (target.kind === 'content') return 'full';
  if (target.kind === 'split') return target.side;
  return null;
}

function BrowserLoadErrorView({
  presentation,
  code,
  url,
  canOpenExternal,
  onReload,
  onOpenExternal,
}: {
  presentation: BrowserLoadErrorPresentation;
  code: string | null;
  url: string;
  canOpenExternal: boolean;
  onReload: () => void;
  onOpenExternal: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-8">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <h1 className="text-base font-medium text-foreground">{presentation.heading}</h1>
        <p className="text-sm text-foreground-muted" title={url}>
          {presentation.detail}
          {code && <span className="text-foreground-tertiary-muted"> ({code})</span>}
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onReload}>
            Reload
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!canOpenExternal}
            onClick={onOpenExternal}
          >
            Open externally
          </Button>
        </div>
      </div>
    </div>
  );
}
