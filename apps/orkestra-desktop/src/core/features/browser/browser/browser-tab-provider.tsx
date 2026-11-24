import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { BrowserTabResource } from '@core/features/browser/api/browser/browser-tab-resource';
import { getAppSettingValueSnapshot } from '@core/features/settings/api/browser/app-settings-client';
import type { TaskTabContext } from '@core/features/workbench/api/browser/tabs/task-tab-context';
import { normalizeBrowserProfileSelection } from '@core/primitives/browser/api';
import type { BrowserSessionSnapshot } from '@core/primitives/browser/api';
import type {
  TabEntry,
  TabHandle,
  TabProvider,
  TabViewContext,
  TabContentProps,
  ResolvedTab,
} from '@core/primitives/workbench-shell/browser/tabs/core/tab-provider';
import { createTabProvider } from '@core/primitives/workbench-shell/browser/tabs/core/tab-provider-registry';
import { BrowserTabBarItem, BrowserTabBarItemDragPreview } from './browser-tab-item';

export interface BrowserState {
  browserId: string;
  /** Session snapshot — kept current by BrowserTabResource's MobX reaction. */
  session: BrowserSessionSnapshot;
}

export interface BrowserOpenArgs {
  initialUrl?: string;
  browserId?: string;
  profileId?: string;
}

function LegacyBrowserTabMigrator({ tab }: { tab: ResolvedTab<BrowserTabResource> }) {
  useEffect(() => {
    tab.resource.adoptAndCloseLegacy();
  }, [tab.resource]);
  return null;
}

/**
 * Eski çalışma alanı sekmelerinden yüklenen kalıcı `kind: 'browser'` sekmelerini sessizce yeni T3
 * sağ tarayıcı paneline devreder; böylece kayıtlı düzenler bozulmaz ve veri kaybı olmaz.
 */
const BrowserTabContent = observer(function BrowserTabContent({ host }: TabContentProps) {
  const browserTabs = host.resolvedTabs.filter(
    (t): t is ResolvedTab<BrowserTabResource> => t.kind === 'browser'
  );

  return (
    <>
      {browserTabs.map((tab) => (
        <LegacyBrowserTabMigrator key={tab.tabId} tab={tab} />
      ))}
    </>
  );
});

export const browserTabProvider: TabProvider<
  'browser',
  BrowserState,
  BrowserTabResource,
  BrowserOpenArgs
> = createTabProvider({
  kind: 'browser',
  resourceKey: (s: BrowserState) => s.browserId,

  onBeforeOpen(args: BrowserOpenArgs, ctx: TabViewContext): BrowserState | null {
    const taskCtx = ctx as TaskTabContext;
    if (args.browserId !== undefined && browserSessionStore.getSession(args.browserId)) return null;
    const browserSettings = getAppSettingValueSnapshot('browser');
    const profileId = normalizeBrowserProfileSelection(
      args.profileId ?? browserSettings?.defaultProfileId,
      browserSettings?.profiles
    );
    const session = browserSessionStore.createSession({
      projectId: taskCtx.projectId,
      workspaceId: taskCtx.workspaceId,
      taskId: taskCtx.taskId,
      browserId: args.browserId,
      profileId,
      initialUrl: args.initialUrl,
    });
    return { browserId: session.browserId, session };
  },

  initialize(
    entry: TabEntry<BrowserState>,
    handle: TabHandle,
    _ctx: TabViewContext
  ): BrowserTabResource {
    return new BrowserTabResource(entry, handle);
  },

  dispose(_entry: TabEntry<BrowserState>, resource: BrowserTabResource): void {
    resource.dispose();
  },

  TabBarItem: BrowserTabBarItem,
  TabBarItemDragPreview: BrowserTabBarItemDragPreview,
  TabContent: BrowserTabContent,
});
