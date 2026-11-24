// Adapted from pingdotgg/t3code (MIT) — overflow menu for T3-style right browser panel.
import { Button, DropdownMenu, toast } from '@orkestra/ui/react/primitives';
import {
  Minus,
  MonitorSmartphone,
  MoreVertical,
  PictureInPicture2,
  Plus,
  RotateCcw,
  Search,
  SunMoon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import {
  BROWSER_AGENT_PROFILE_ID,
  BROWSER_DEFAULT_URL,
  BROWSER_DEFAULT_ZOOM_FACTOR,
  BROWSER_ISOLATED_PROFILE_ID,
  DEFAULT_BROWSER_PROFILES,
  browserProfileLabel,
  canZoomIn,
  canZoomOut,
  formatBrowserZoomPercent,
  isDefaultBrowserZoomFactor,
  nextBrowserZoomFactor,
  normalizeBrowserZoomFactor,
  previousBrowserZoomFactor,
  type BrowserColorScheme,
  type BrowserSessionSnapshot,
} from '@core/primitives/browser/api';
import type { BrowserRecordingStatus } from '@core/primitives/browser/api/agent-browser';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import {
  canOpenBrowserUrlExternally,
  clearBrowserData,
  confirmClearBrowserStorage,
  copyBrowserRecording,
  fetchBrowserRecordingStatus,
  openBrowserUrlExternally,
  toggleBrowserRecording,
} from './browser-toolbar-actions';
import type { BrowserWebviewAdapter } from './browser-webview-types';

const PROFILE_RADIO_ITEM_CLASS = 'text-foreground data-checked:bg-transparent';

export function BrowserMoreMenu({
  session,
  adapter,
  deviceToolbarOpen,
  onToggleFind,
  onForceReload,
  onToggleDeviceToolbar,
  onSetZoomFactor,
}: {
  session: BrowserSessionSnapshot;
  adapter: BrowserWebviewAdapter | null;
  deviceToolbarOpen: boolean;
  onToggleFind: () => void;
  onForceReload: () => void;
  onToggleDeviceToolbar: () => void;
  onSetZoomFactor: (factor: number) => void;
}) {
  const [recordingStatus, setRecordingStatus] = useState<BrowserRecordingStatus | null>(null);
  const { value: browserSettings } = useAppSettingsKey('browser');
  const { navigate: navigateToView } = useNavigate();

  const zoomFactor = normalizeBrowserZoomFactor(session.zoomFactor);
  const canOpenExternal = canOpenBrowserUrlExternally(session.currentUrl);
  const profiles = browserSettings?.profiles?.length
    ? browserSettings.profiles
    : DEFAULT_BROWSER_PROFILES;
  const colorScheme: BrowserColorScheme = session.colorScheme ?? 'system';

  useEffect(() => {
    setRecordingStatus(null);
  }, [session.browserId]);

  const handleOpenChange = (open: boolean) => {
    if (!open) return;
    void fetchBrowserRecordingStatus(session.browserId).then((status) => {
      if (status) setRecordingStatus(status);
    });
  };

  const handleTogglePip = () => {
    void getBrowserClient().then((client) => {
      if (session.pictureInPicture) {
        return client.closePipWindow({ browserId: session.browserId });
      }
      return client.openPipWindow({ browserId: session.browserId }).then((res) => {
        if (!res.success) {
          toast.error('Ayrı pencere açılamadı', { description: res.error });
        }
        return res;
      });
    });
  };

  const handleColorScheme = (next: BrowserColorScheme) => {
    browserSessionStore.updateSession(session.browserId, { colorScheme: next });
    void getBrowserClient()
      .then((client) => client.setColorScheme({ browserId: session.browserId, colorScheme: next }))
      .catch(() => {});
  };

  const handleOpenDevTools = () => {
    void getBrowserClient().then((client) =>
      client.openDevTools({ browserId: session.browserId }).then((result) => {
        if (!result.success) {
          toast.error('Geliştirici araçları açılamadı', {
            description: 'Sayfa tamamen yüklendikten sonra tekrar deneyin.',
          });
        }
      })
    );
  };

  const switchProfile = (nextProfileId: string) => {
    const nextSession = browserSessionStore.setSessionProfile(
      session.browserId,
      nextProfileId,
      profiles
    );
    if (!nextSession || nextSession.profileId === session.profileId) return;
    void getBrowserClient().then((client) =>
      client.registerSession({
        browserId: nextSession.browserId,
        partition: nextSession.partition,
        projectId: nextSession.projectId,
        workspaceId: nextSession.workspaceId,
        taskId: nextSession.taskId,
        url: nextSession.currentUrl,
        title: nextSession.title,
      })
    );
  };

  return (
    <DropdownMenu.Root onOpenChange={handleOpenChange}>
      <DropdownMenu.Trigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon
            className="size-7 shrink-0"
            aria-label="Diğer tarayıcı seçenekleri"
          />
        }
      >
        <MoreVertical className="size-3.5" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" className="min-w-60">
        <DropdownMenu.Item onClick={onToggleFind}>
          <Search className="size-3.5" />
          Sayfada bul (⌘F)
        </DropdownMenu.Item>
        <DropdownMenu.Item disabled={!adapter} onClick={onForceReload}>
          <RotateCcw className="size-3.5" />
          Zorla yenile
        </DropdownMenu.Item>
        <DropdownMenu.Item
          disabled={session.currentUrl === BROWSER_DEFAULT_URL}
          onClick={handleTogglePip}
        >
          <PictureInPicture2 className="size-3.5" />
          {session.pictureInPicture ? 'Ayrı pencereyi kapat' : 'Ayrı pencerede aç'}
        </DropdownMenu.Item>
        <DropdownMenu.Item onClick={onToggleDeviceToolbar}>
          <MonitorSmartphone className="size-3.5" />
          {deviceToolbarOpen ? 'Cihaz görünümünü kapat' : 'Cihaz görünümü'}
        </DropdownMenu.Item>
        <DropdownMenu.Item disabled={!canOpenExternal} onClick={() => openBrowserUrlExternally(session.currentUrl)}>
          Harici tarayıcıda aç
        </DropdownMenu.Item>
        <DropdownMenu.Item onClick={handleOpenDevTools}>Geliştirici araçları</DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger>
            <SunMoon className="size-3.5" />
            Görünüm ({colorScheme === 'dark' ? 'Koyu' : colorScheme === 'light' ? 'Açık' : 'Sistem'})
          </DropdownMenu.SubTrigger>
          <DropdownMenu.SubContent className="min-w-36">
            <DropdownMenu.RadioGroup
              value={colorScheme}
              onValueChange={(value) => handleColorScheme(String(value) as BrowserColorScheme)}
            >
              <DropdownMenu.RadioItem value="system" className={PROFILE_RADIO_ITEM_CLASS}>
                Sistem
              </DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem value="light" className={PROFILE_RADIO_ITEM_CLASS}>
                Açık
              </DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem value="dark" className={PROFILE_RADIO_ITEM_CLASS}>
                Koyu
              </DropdownMenu.RadioItem>
            </DropdownMenu.RadioGroup>
          </DropdownMenu.SubContent>
        </DropdownMenu.Sub>
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger>Tarayıcı profili</DropdownMenu.SubTrigger>
          <DropdownMenu.SubContent className="min-w-44">
            <DropdownMenu.RadioGroup
              value={session.profileId}
              onValueChange={(value) => switchProfile(String(value))}
            >
              {profiles.map((profile) => (
                <DropdownMenu.RadioItem
                  key={profile.id}
                  value={profile.id}
                  className={PROFILE_RADIO_ITEM_CLASS}
                >
                  {profile.name}
                </DropdownMenu.RadioItem>
              ))}
              <DropdownMenu.RadioItem
                value={BROWSER_ISOLATED_PROFILE_ID}
                className={PROFILE_RADIO_ITEM_CLASS}
              >
                Görev başına yalıtılmış
              </DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem
                value={BROWSER_AGENT_PROFILE_ID}
                className={PROFILE_RADIO_ITEM_CLASS}
              >
                Ajan
              </DropdownMenu.RadioItem>
            </DropdownMenu.RadioGroup>
            <DropdownMenu.Separator />
            <DropdownMenu.Item onClick={() => navigateToView(settingsViewDef({ tab: 'browser' }))}>
              Profilleri yönet…
            </DropdownMenu.Item>
          </DropdownMenu.SubContent>
        </DropdownMenu.Sub>
        <DropdownMenu.Separator />
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
          <span>Yakınlaştırma</span>
          <div className="flex items-center gap-1">
            <div className="flex items-center rounded-md bg-background-quaternary-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon
                className="size-6"
                aria-label="Uzaklaştır"
                disabled={!canZoomOut(zoomFactor)}
                onClick={() => onSetZoomFactor(previousBrowserZoomFactor(zoomFactor))}
              >
                <Minus className="size-3.5" />
              </Button>
              <span className="min-w-11 text-center text-xs text-foreground-muted tabular-nums">
                {formatBrowserZoomPercent(zoomFactor)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon
                className="size-6"
                aria-label="Yakınlaştır"
                disabled={!canZoomIn(zoomFactor)}
                onClick={() => onSetZoomFactor(nextBrowserZoomFactor(zoomFactor))}
              >
                <Plus className="size-3.5" />
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon
              className="size-6"
              aria-label="Yakınlaştırmayı sıfırla"
              disabled={isDefaultBrowserZoomFactor(zoomFactor)}
              onClick={() => onSetZoomFactor(BROWSER_DEFAULT_ZOOM_FACTOR)}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </div>
        </div>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          disabled={!adapter}
          onClick={() =>
            void toggleBrowserRecording(
              session.browserId,
              recordingStatus?.recording ?? false
            ).then((status) => {
              if (status) setRecordingStatus(status);
            })
          }
        >
          {recordingStatus?.recording ? 'Kaydı durdur' : 'Kaydı başlat'}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          disabled={!recordingStatus?.stepCount}
          onClick={() => void copyBrowserRecording(session.browserId)}
        >
          Kaydı kopyala (JSON)
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          disabled={!adapter}
          onClick={() => clearBrowserData(session, 'cookies', () => adapter?.reload())}
        >
          Çerezleri temizle
        </DropdownMenu.Item>
        <DropdownMenu.Item
          disabled={!adapter}
          onClick={() => clearBrowserData(session, 'cache', () => adapter?.reloadIgnoringCache())}
        >
          Önbelleği temizle
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() =>
            confirmClearBrowserStorage(
              session,
              adapter,
              browserProfileLabel(session.profileId, profiles)
            )
          }
        >
          Tarayıcı verilerini temizle
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
