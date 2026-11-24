// Adapted from pingdotgg/t3code (MIT) — T3-style preview chrome/address row.
import { Button, Tooltip, toast } from '@orkestra/ui/react/primitives';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  Globe,
  MousePointerClick,
  PictureInPicture2,
  RotateCw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserPickedElement } from '@core/features/browser/api';
import { browserRightPanelStore } from '@core/features/browser/api/browser/browser-right-panel-store';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import {
  normalizeBrowserUrl,
  type BrowserSessionSnapshot,
} from '@core/primitives/browser/api';
import { cn } from '@core/primitives/styling/browser/cn';
import { BrowserMoreMenu } from './browser-more-menu';
import {
  canOpenBrowserUrlExternally,
  captureBrowserScreenshot,
  openBrowserUrlExternally,
} from './browser-toolbar-actions';
import { browserUrlInputText } from './browser-url-input';
import type { BrowserWebviewAdapter } from './browser-webview-types';

export function BrowserChromeRow({
  session,
  adapter,
  deviceToolbarOpen,
  onNavigate,
  onGoBack,
  onGoForward,
  onReload,
  onForceReload,
  onSetZoomFactor,
  onFocusUrl,
  onToggleFind,
  onToggleDeviceToolbar,
  onElementPicked,
}: {
  session: BrowserSessionSnapshot;
  adapter: BrowserWebviewAdapter | null;
  deviceToolbarOpen: boolean;
  onNavigate: (url: string) => boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
  onForceReload: () => void;
  onSetZoomFactor: (factor: number) => void;
  onFocusUrl: (focus: () => void) => void;
  onToggleFind: () => void;
  onToggleDeviceToolbar: () => void;
  onElementPicked: (el: BrowserPickedElement | null) => void;
}) {
  const [urlText, setUrlText] = useState(browserUrlInputText(session.currentUrl));
  const [pickingElement, setPickingElement] = useState(false);
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setUrlText(browserUrlInputText(session.currentUrl));
  }, [session.browserId, session.currentUrl]);

  useEffect(() => {
    onFocusUrl(() => {
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    });
  }, [onFocusUrl]);

  const handleSubmit = useCallback(() => {
    const normalized = normalizeBrowserUrl(urlText);
    if (!normalized.ok) {
      toast.error('Geçersiz adres', { description: urlText.trim() || 'Bir URL girin.' });
      return;
    }
    onNavigate(normalized.url);
    urlInputRef.current?.blur();
  }, [onNavigate, urlText]);

  const canOpenExternal = canOpenBrowserUrlExternally(session.currentUrl);
  const isBlank = session.currentUrl === 'about:blank';

  const handlePickElement = () => {
    if (pickingElement) {
      setPickingElement(false);
      void getBrowserClient().then((c) => c.cancelPickElement({ browserId: session.browserId }));
      return;
    }
    setPickingElement(true);
    onElementPicked(null);
    void getBrowserClient()
      .then((c) => c.pickElement({ browserId: session.browserId }))
      .then((res) => {
        if (!res.success) {
          toast.error('Öğe seçilemedi', { description: res.error });
        } else if (!res.cancelled && res.element) {
          onElementPicked(res.element);
        }
      })
      .catch(() => toast.error('Öğe seçimi başlatılamadı'))
      .finally(() => setPickingElement(false));
  };

  return (
    <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-border/70 bg-background px-2">
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon
              className="size-7 shrink-0"
              disabled={!session.canGoBack}
              aria-label="Geri"
              onClick={onGoBack}
            />
          }
        >
          <ArrowLeft className="size-3.5" />
        </Tooltip.Trigger>
        <Tooltip.Content>Geri</Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon
              className="size-7 shrink-0"
              disabled={!session.canGoForward}
              aria-label="İleri"
              onClick={onGoForward}
            />
          }
        >
          <ArrowRight className="size-3.5" />
        </Tooltip.Trigger>
        <Tooltip.Content>İleri</Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon
              className="size-7 shrink-0"
              aria-label={session.isLoading ? 'Yüklemeyi durdur' : 'Yenile'}
              onClick={onReload}
            />
          }
        >
          {session.isLoading ? (
            <X className="size-3.5" />
          ) : (
            <RotateCw className="size-3.5" />
          )}
        </Tooltip.Trigger>
        <Tooltip.Content>{session.isLoading ? 'Durdur' : 'Yenile'}</Tooltip.Content>
      </Tooltip.Root>

      <form
        className="min-w-0 flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <div className="group/url relative flex h-7 items-center rounded-md border border-border/80 bg-background-secondary/75 px-2 transition-colors focus-within:border-sky-500/75 focus-within:ring-1 focus-within:ring-sky-500/35">
          <Globe className="mr-1.5 size-3.5 shrink-0 text-foreground-muted" />
          <input
            ref={urlInputRef}
            type="text"
            value={urlText}
            onChange={(e) => setUrlText(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setUrlText(browserUrlInputText(session.currentUrl));
                e.currentTarget.blur();
              }
            }}
            placeholder="URL girin veya arayın..."
            aria-label="Tarayıcı Adresi"
            spellCheck={false}
            autoCapitalize="none"
            className="h-full min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-foreground-muted"
          />
          {canOpenExternal ? (
            <button
              type="button"
              aria-label="Harici tarayıcıda aç"
              className="ml-1 flex size-5 shrink-0 items-center justify-center rounded-xs text-foreground-muted opacity-0 transition-opacity hover:text-foreground group-hover/url:opacity-100 group-focus-within/url:opacity-100"
              onClick={() => openBrowserUrlExternally(session.currentUrl)}
            >
              <ExternalLink className="size-3" />
            </button>
          ) : null}
          {session.isLoading ? (
            <div className="pointer-events-none absolute right-0 bottom-0 left-0 h-[2px] overflow-hidden rounded-b-md bg-sky-500/15">
              <div className="h-full w-1/2 animate-pulse bg-sky-500" />
            </div>
          ) : null}
        </div>
      </form>

      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon
              className="size-7 shrink-0"
              disabled={isBlank || session.isLoading}
              aria-label={pickingElement ? 'Öğe seçimini iptal et' : 'Sayfadan öğe seç'}
              onClick={handlePickElement}
            />
          }
        >
          <MousePointerClick
            className={cn('size-3.5', pickingElement && 'animate-pulse text-sky-400')}
          />
        </Tooltip.Trigger>
        <Tooltip.Content>Öğe seç ve sohbete ekle</Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon
              className="size-7 shrink-0"
              disabled={isBlank || session.isLoading}
              aria-label="Ekran görüntüsü al"
              onClick={() => void captureBrowserScreenshot(session)}
            />
          }
        >
          <Camera className="size-3.5" />
        </Tooltip.Trigger>
        <Tooltip.Content>Ekran görüntüsünü panoya kopyala</Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon
              className="size-7 shrink-0"
              aria-label="Yüzen mini pencereye küçült"
              onClick={() =>
                browserRightPanelStore.floatTabToMiniPlayer(
                  session.projectId,
                  session.taskId,
                  session.browserId
                )
              }
            />
          }
        >
          <PictureInPicture2 className="size-3.5" />
        </Tooltip.Trigger>
        <Tooltip.Content>Yüzen mini pencereye küçült</Tooltip.Content>
      </Tooltip.Root>

      <BrowserMoreMenu
        session={session}
        adapter={adapter}
        deviceToolbarOpen={deviceToolbarOpen}
        onToggleFind={onToggleFind}
        onForceReload={onForceReload}
        onToggleDeviceToolbar={onToggleDeviceToolbar}
        onSetZoomFactor={onSetZoomFactor}
      />
    </div>
  );
}
