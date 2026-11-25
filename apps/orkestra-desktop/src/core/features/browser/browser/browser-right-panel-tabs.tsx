// Adapted from pingdotgg/t3code (MIT) — top dark pill tab bar for right browser panel.
import { Button, Tooltip } from '@orkestra/ui/react/primitives';
import { Globe, Maximize2, Minimize2, Plus, Volume2, VolumeX, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { browserAgentActivity } from '@core/features/browser/api/browser/browser-agent-activity';
import { browserRightPanelStore } from '@core/features/browser/api/browser/browser-right-panel-store';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import { BROWSER_DEFAULT_URL } from '@core/primitives/browser/api';
import { cn } from '@core/primitives/styling/browser/cn';

function formatTabTitle(url: string, title: string): string {
  if (title.trim()) return title.trim();
  if (!url || url === BROWSER_DEFAULT_URL) return 'Yeni sekme';
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

export const BrowserRightPanelTabs = observer(function BrowserRightPanelTabs({
  projectId,
  workspaceId,
  taskId,
  tabIds,
  activeBrowserId,
  maximized,
}: {
  projectId: string;
  workspaceId: string;
  taskId: string;
  tabIds: readonly string[];
  activeBrowserId: string | null;
  maximized: boolean;
}) {
  const [failedFavicons, setFailedFavicons] = useState<Record<string, string>>({});

  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-background-secondary/50 px-2">
      <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabIds.map((browserId) => {
          const session = browserSessionStore.getSession(browserId);
          if (!session) return null;
          const active = browserId === activeBrowserId;
          const label = formatTabTitle(session.currentUrl, session.title);
          const faviconUrl =
            session.faviconUrl && failedFavicons[browserId] !== session.faviconUrl
              ? session.faviconUrl
              : undefined;
          const agentActive = browserAgentActivity.isActive(browserId);
          const showAudio = Boolean(session.audible || session.audioMuted);

          return (
            <div
              key={browserId}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onClick={() => browserRightPanelStore.setActiveTab(projectId, taskId, browserId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  browserRightPanelStore.setActiveTab(projectId, taskId, browserId);
                }
              }}
              className={cn(
                'group flex h-7 max-w-44 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs transition-colors select-none',
                active
                  ? 'bg-background text-foreground shadow-xs ring-1 ring-border/70'
                  : 'text-foreground-muted hover:bg-background/60 hover:text-foreground'
              )}
              title={label}
            >
              {faviconUrl ? (
                <img
                  src={faviconUrl}
                  alt=""
                  draggable={false}
                  className="size-3.5 shrink-0 rounded-xs"
                  onError={() =>
                    setFailedFavicons((prev) => ({ ...prev, [browserId]: faviconUrl }))
                  }
                />
              ) : (
                <Globe className="size-3.5 shrink-0 text-foreground-muted" />
              )}

              {showAudio ? (
                <button
                  type="button"
                  aria-label={session.audioMuted ? 'Sesi aç' : 'Sesi kapat'}
                  className="hover:bg-accent flex size-4 shrink-0 items-center justify-center rounded-xs text-foreground-muted hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    const nextMuted = !session.audioMuted;
                    browserSessionStore.updateSession(browserId, { audioMuted: nextMuted });
                    void getBrowserClient()
                      .then((client) => client.setAudioMuted({ browserId, muted: nextMuted }))
                      .catch(() => {});
                  }}
                >
                  {session.audioMuted ? (
                    <VolumeX className="size-3 text-foreground-muted" />
                  ) : (
                    <Volume2 className="size-3 text-sky-400" />
                  )}
                </button>
              ) : null}

              <span className="min-w-0 flex-1 truncate">{label}</span>

              {agentActive ? (
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 animate-pulse rounded-full bg-sky-400"
                />
              ) : null}

              <button
                type="button"
                aria-label={`Sekmeyi kapat: ${label}`}
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-xs text-foreground-muted transition-opacity hover:bg-accent hover:text-foreground',
                  active ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-100'
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  browserRightPanelStore.closeTab(projectId, taskId, browserId);
                }}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}

        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon
                className="size-7 shrink-0 text-foreground-muted hover:text-foreground"
                aria-label="Yeni sekme"
                onClick={() =>
                  browserRightPanelStore.openTab(
                    { projectId, workspaceId, taskId },
                    { mode: 'panel', activate: true }
                  )
                }
              />
            }
          >
            <Plus className="size-3.5" />
          </Tooltip.Trigger>
          <Tooltip.Content>Yeni sekme</Tooltip.Content>
        </Tooltip.Root>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon
                className="size-7 shrink-0 text-foreground-muted hover:text-foreground"
                aria-label={maximized ? 'Paneli eski boyutuna döndür' : 'Paneli büyüt'}
                onClick={() => browserRightPanelStore.toggleMaximized(projectId, taskId)}
              />
            }
          >
            {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </Tooltip.Trigger>
          <Tooltip.Content>{maximized ? 'Eski boyuta dön' : 'Genişlet'}</Tooltip.Content>
        </Tooltip.Root>
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon
                className="size-7 shrink-0 text-foreground-muted hover:text-foreground"
                aria-label="Tarayıcı panelini kapat"
                onClick={() => browserRightPanelStore.closePanel(projectId, taskId)}
              />
            }
          >
            <X className="size-3.5" />
          </Tooltip.Trigger>
          <Tooltip.Content>Paneli kapat</Tooltip.Content>
        </Tooltip.Root>
      </div>
    </div>
  );
});
