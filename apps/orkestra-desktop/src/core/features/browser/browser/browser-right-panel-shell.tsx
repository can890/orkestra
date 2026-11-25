// Adapted from pingdotgg/t3code (MIT) — inline resizable right browser panel shell.
import { Button } from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { BrowserPickedElement } from '@core/features/browser/api';
import { browserControlsRegistry } from '@core/features/browser/api/browser/browser-controls-registry';
import { browserRightPanelStore } from '@core/features/browser/api/browser/browser-right-panel-store';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { browserWebviewHost } from '@core/features/browser/api/browser/browser-webview-host';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import { usePreviewServers } from '@core/features/workbench/api/browser/task-composition-context';
import {
  BROWSER_DEFAULT_URL,
  normalizeBrowserUrl,
  normalizeBrowserZoomFactor,
} from '@core/primitives/browser/api';
import { cn } from '@core/primitives/styling/browser/cn';
import { useViewScopeInstance } from '@core/primitives/view-scopes/react';
import { BrowserChromeRow } from './browser-chrome-row';
import { BrowserDeviceToolbar, type DeviceViewportState } from './browser-device-toolbar';
import { BrowserElementAnnotationPopover } from './browser-element-annotation-popover';
import { BrowserFindBar } from './browser-find-bar';
import {
  browserLoadErrorCode,
  describeBrowserLoadError,
  type BrowserLoadErrorPresentation,
} from './browser-load-error';
import { decideBrowserReload } from './browser-navigation-controls';
import { BrowserRightPanelTabs } from './browser-right-panel-tabs';
import { BrowserStartPage } from './browser-start-page';
import { canOpenBrowserUrlExternally, openBrowserUrlExternally } from './browser-toolbar-actions';
import { useBrowserWebviewSlot } from './browser-webview-slot';

const DEFAULT_DEVICE_VIEWPORT: DeviceViewportState = {
  presetId: 'responsive',
  width: 0,
  height: 0,
  rotated: false,
};

export const BrowserRightPanelShell = observer(function BrowserRightPanelShell({
  projectId,
  workspaceId,
  taskId,
}: {
  projectId: string;
  workspaceId: string;
  taskId: string;
}) {
  const isOpen = browserRightPanelStore.isOpen(projectId, taskId);
  const maximized = browserRightPanelStore.isMaximized(projectId, taskId);
  const tabIds = browserRightPanelStore.tabsForTask(projectId, taskId);
  const activeBrowserId = browserRightPanelStore.activeTabForTask(projectId, taskId);
  const panelWidth = browserRightPanelStore.panelWidth;
  const taskScope = useViewScopeInstance();
  const previewServers = usePreviewServers();

  const [resizing, setResizing] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [deviceToolbarOpen, setDeviceToolbarOpen] = useState(false);
  const [deviceViewport, setDeviceViewport] =
    useState<DeviceViewportState>(DEFAULT_DEVICE_VIEWPORT);
  const [pickedElement, setPickedElement] = useState<BrowserPickedElement | null>(null);

  const regionRef = useRef<HTMLDivElement | null>(null);
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const focusUrlRef = useRef<() => void>(() => {});
  const resizeGestureRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  const session = activeBrowserId ? browserSessionStore.getSession(activeBrowserId) : undefined;
  const adapter = activeBrowserId ? browserControlsRegistry.getAdapter(activeBrowserId) : null;
  const isRegistered = activeBrowserId ? browserWebviewHost.isRegistered(activeBrowserId) : false;

  const showStartPage = session?.currentUrl === BROWSER_DEFAULT_URL;
  const loadError = session && !session.isLoading ? session.loadError : undefined;
  const loadErrorUrl = loadError ? (loadError.url ?? session?.currentUrl ?? '') : '';
  const loadErrorPresentation = useMemo<BrowserLoadErrorPresentation | undefined>(
    () => (loadError ? describeBrowserLoadError(loadError, loadErrorUrl) : undefined),
    [loadError, loadErrorUrl]
  );
  const showLoadError = Boolean(loadError && loadErrorPresentation);
  const showWebview = Boolean(
    isOpen && activeBrowserId && session && !showStartPage && !showLoadError
  );

  useBrowserWebviewSlot({
    browserId: activeBrowserId ?? '',
    placeholderRef,
    regionRef,
    show: showWebview,
    interactive: !resizing,
    scopeId: taskScope?.id,
    highlight: null,
    zIndex: 30,
    cornerRadius: 0,
  });

  useEffect(() => {
    if (!isOpen || !activeBrowserId) return;
    void getBrowserClient()
      .then((client) => client.setActiveBrowser({ browserId: activeBrowserId }))
      .catch(() => {});
  }, [activeBrowserId, isOpen]);

  useEffect(() => {
    if (!activeBrowserId) return;
    return browserControlsRegistry.registerUrlFocuser(activeBrowserId, () => focusUrlRef.current());
  }, [activeBrowserId]);

  useEffect(() => {
    setPickedElement(null);
    setFindOpen(false);
  }, [activeBrowserId]);

  const registerFocusUrl = useCallback((fn: () => void) => {
    focusUrlRef.current = fn;
  }, []);

  const loadUrl = useCallback(
    (url: string) => {
      if (!activeBrowserId) return;
      browserSessionStore.updateSession(activeBrowserId, {
        currentUrl: url,
        faviconUrl: null,
        isLoading: true,
        loadError: null,
      });
      browserWebviewHost.load(activeBrowserId, url);
    },
    [activeBrowserId]
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
    if (adapter?.canGoBack()) adapter.goBack();
  }, [adapter]);

  const goForward = useCallback(() => {
    if (adapter?.canGoForward()) adapter.goForward();
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
      if (!activeBrowserId) return;
      const zoomFactor = normalizeBrowserZoomFactor(factor);
      browserSessionStore.updateSession(activeBrowserId, { zoomFactor });
      adapter?.setZoomFactor(zoomFactor);
    },
    [activeBrowserId, adapter]
  );

  if (!isOpen) return null;

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || maximized) return;
    event.preventDefault();
    resizeGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: panelWidth,
    };
    setResizing(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // İhmal et.
    }
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = resizeGestureRef.current;
    if (!g || g.pointerId !== event.pointerId) return;
    const next = g.startWidth - (event.clientX - g.startX);
    browserRightPanelStore.setPanelWidth(next);
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = resizeGestureRef.current;
    if (!g || g.pointerId !== event.pointerId) return;
    resizeGestureRef.current = null;
    setResizing(false);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // İhmal et.
    }
  };

  const deviceW =
    deviceToolbarOpen && deviceViewport.width > 0
      ? deviceViewport.rotated
        ? deviceViewport.height
        : deviceViewport.width
      : 0;
  const deviceH =
    deviceToolbarOpen && deviceViewport.height > 0
      ? deviceViewport.rotated
        ? deviceViewport.width
        : deviceViewport.height
      : 0;
  const isConstrainedDevice = deviceW > 0 && deviceH > 0;

  return (
    <aside
      aria-label="Tarayıcı paneli"
      data-browser-right-panel=""
      className={cn(
        'relative flex h-full min-h-0 flex-col border-l border-border bg-background',
        maximized ? 'min-w-0 flex-1' : 'shrink-0'
      )}
      style={maximized ? undefined : { width: panelWidth }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && activeBrowserId) {
          e.preventDefault();
          setFindOpen((open) => !open);
        }
      }}
    >
      {!maximized ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Tarayıcı panelini boyutlandır"
          className="absolute inset-y-0 -left-1 z-20 w-2 cursor-ew-resize touch-none transition-colors hover:bg-sky-500/35"
          onPointerDown={beginResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
      ) : null}

      <BrowserRightPanelTabs
        projectId={projectId}
        workspaceId={workspaceId}
        taskId={taskId}
        tabIds={tabIds}
        activeBrowserId={activeBrowserId}
        maximized={maximized}
      />

      {session ? (
        <>
          <BrowserChromeRow
            session={session}
            adapter={adapter}
            deviceToolbarOpen={deviceToolbarOpen}
            onNavigate={navigateTo}
            onGoBack={goBack}
            onGoForward={goForward}
            onReload={reload}
            onForceReload={forceReload}
            onSetZoomFactor={setZoomFactor}
            onFocusUrl={registerFocusUrl}
            onToggleFind={() => setFindOpen((open) => !open)}
            onToggleDeviceToolbar={() => setDeviceToolbarOpen((open) => !open)}
            onElementPicked={setPickedElement}
          />
          <BrowserElementAnnotationPopover
            element={pickedElement}
            onClose={() => setPickedElement(null)}
          />
          {findOpen ? (
            <BrowserFindBar browserId={session.browserId} onClose={() => setFindOpen(false)} />
          ) : null}
          {deviceToolbarOpen ? (
            <BrowserDeviceToolbar
              viewport={deviceViewport}
              onChange={setDeviceViewport}
              onClose={() => {
                setDeviceToolbarOpen(false);
                setDeviceViewport(DEFAULT_DEVICE_VIEWPORT);
              }}
            />
          ) : null}
        </>
      ) : null}

      <div ref={regionRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
        <div
          className={cn(
            'absolute inset-0',
            isConstrainedDevice &&
              'flex items-center justify-center overflow-auto bg-background-secondary/50 p-4'
          )}
        >
          <div
            ref={placeholderRef}
            data-browser-webview-placeholder={activeBrowserId ?? undefined}
            tabIndex={showWebview ? -1 : undefined}
            className={cn(
              'outline-none',
              isConstrainedDevice
                ? 'relative shrink-0 overflow-hidden rounded-lg border border-border shadow-xl'
                : 'h-full w-full'
            )}
            style={
              isConstrainedDevice
                ? { width: deviceW, height: deviceH, maxWidth: '100%', maxHeight: '100%' }
                : undefined
            }
            onFocus={() => adapter?.focus()}
          />
        </div>

        {showLoadError && loadErrorPresentation && loadError ? (
          <div className="relative z-10 flex h-full items-center justify-center overflow-auto bg-background p-8">
            <div className="flex max-w-sm flex-col items-center gap-2 text-center">
              <h1 className="text-base font-medium text-foreground">
                {loadErrorPresentation.heading}
              </h1>
              <p className="text-sm text-foreground-muted" title={loadErrorUrl}>
                {loadErrorPresentation.detail}
                {browserLoadErrorCode(loadError) ? (
                  <span className="text-foreground-tertiary-muted">
                    {' '}
                    ({browserLoadErrorCode(loadError)})
                  </span>
                ) : null}
              </p>
              <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={reload}>
                  Yeniden yükle
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!canOpenBrowserUrlExternally(loadErrorUrl)}
                  onClick={() => openBrowserUrlExternally(loadErrorUrl)}
                >
                  Harici aç
                </Button>
              </div>
            </div>
          </div>
        ) : showStartPage ? (
          <div className="relative z-10 h-full">
            <BrowserStartPage devServerUrls={previewServers.urls} onOpenUrl={navigateTo} />
          </div>
        ) : activeBrowserId && !isRegistered ? (
          <div className="relative z-10 flex h-full items-center justify-center bg-background text-sm text-foreground-muted">
            Tarayıcı oturumu hazırlanıyor…
          </div>
        ) : null}
      </div>
    </aside>
  );
});
