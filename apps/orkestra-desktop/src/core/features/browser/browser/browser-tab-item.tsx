import { Bot, Globe, Loader2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { browserAgentActivity } from '@core/features/browser/api/browser/browser-agent-activity';
import type { BrowserTabResource } from '@core/features/browser/api/browser/browser-tab-resource';
import type { BrowserSessionSnapshot } from '@core/primitives/browser/api';
import { cn } from '@core/primitives/styling/browser/cn';
import type {
  TabBarItemProps,
  ResolvedTab,
} from '@core/primitives/workbench-shell/browser/tabs/core/tab-provider';
import {
  GenericTabDragPreview,
  GenericTabItem,
} from '@core/primitives/workbench-shell/browser/tabs/tab-bar/generic-tab-item';

function browserTabLabel(session: BrowserSessionSnapshot | undefined): string {
  if (!session) return 'Browser';
  if (session.title.trim()) return session.title.trim();
  if (session.currentUrl === 'about:blank') return 'Browser';
  try {
    return new URL(session.currentUrl).host;
  } catch {
    return 'Browser';
  }
}

export const BrowserTabBarItem = observer(function BrowserTabBarItem({
  tab,
  host,
  ctx,
}: TabBarItemProps<BrowserTabResource>) {
  const session = tab.resource.session;
  const label = browserTabLabel(session);
  // A short-lived hint while an agent drives this tab (see browserAgentActivity).
  const agentActive = browserAgentActivity.isActive(tab.resource.browserId);

  return (
    <GenericTabItem
      tab={tab}
      host={host}
      ctx={ctx}
      label={label}
      tooltip={agentActive ? `${label} · Ajan bu sekmeyi kullanıyor` : undefined}
      preSlot={
        <span
          className={cn(
            'shrink-0 [&>svg]:h-3 [&>svg]:w-3',
            agentActive ? 'text-foreground-info' : 'text-foreground-muted'
          )}
          data-agent-active={agentActive ? '' : undefined}
        >
          {session?.isLoading ? (
            <Loader2 className="animate-spin" />
          ) : agentActive ? (
            <Bot aria-label="Ajan bu sekmeyi kullanıyor" />
          ) : (
            <Globe />
          )}
        </span>
      }
      hasError={!!session?.loadError}
    />
  );
});

export function BrowserTabBarItemDragPreview({ tab }: { tab: ResolvedTab<BrowserTabResource> }) {
  const label = browserTabLabel(tab.resource.session);
  return (
    <GenericTabDragPreview
      preSlot={<Globe className="size-3 shrink-0 text-foreground-muted" />}
      label={label}
    />
  );
}
