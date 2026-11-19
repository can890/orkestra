import { Smartphone } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type {
  TabBarItemProps,
  TabContentProps,
  TabEntry,
  TabHandle,
  TabProvider,
  TabResource,
  TabViewContext,
  ResolvedTab,
} from '@core/primitives/workbench-shell/browser/tabs/core/tab-provider';
import { createTabProvider } from '@core/primitives/workbench-shell/browser/tabs/core/tab-provider-registry';
import {
  GenericTabDragPreview,
  GenericTabItem,
} from '@core/primitives/workbench-shell/browser/tabs/tab-bar/generic-tab-item';
import { SimulatorPanel } from './simulator-panel';

/** Görev başına tek simülatör sekmesi vardır; sekmenin kalıcı bir durumu yoktur. */
export type SimulatorTabState = Record<string, never>;

class SimulatorTabResource implements TabResource {
  dispose(): void {}
}

const LABEL = 'iOS Simülatör';

const SimulatorTabBarItem = observer(function SimulatorTabBarItem({
  tab,
  host,
  ctx,
}: TabBarItemProps<SimulatorTabResource>) {
  return (
    <GenericTabItem
      tab={tab}
      host={host}
      ctx={ctx}
      label={LABEL}
      preSlot={<Smartphone className="size-4 shrink-0" />}
    />
  );
});

function SimulatorTabDragPreview(_props: { tab: ResolvedTab<SimulatorTabResource> }) {
  return (
    <GenericTabDragPreview preSlot={<Smartphone className="size-4 shrink-0" />} label={LABEL} />
  );
}

/**
 * Panel yalnızca simülatör sekmesi etkinken bağlanır: başka sekmeye geçilince ya da sekme
 * kapanınca bileşen kaldırılır ve canlı görüntü yoklaması durur.
 */
const SimulatorTabContent = observer(function SimulatorTabContent({ host }: TabContentProps) {
  const activeTab = host.resolvedTabs.find((tab) => tab.isActive);
  if (activeTab?.kind !== 'simulator') return null;
  return <SimulatorPanel />;
});

export const simulatorTabProvider: TabProvider<
  'simulator',
  SimulatorTabState,
  SimulatorTabResource,
  Record<string, never>
> = createTabProvider({
  kind: 'simulator',
  mount: 'single',
  resourceKey: () => 'simulator',

  onBeforeOpen(_args: Record<string, never>, _ctx: TabViewContext): SimulatorTabState {
    return {};
  },

  initialize(
    _entry: TabEntry<SimulatorTabState>,
    _handle: TabHandle,
    _ctx: TabViewContext
  ): SimulatorTabResource {
    return new SimulatorTabResource();
  },

  dispose(_entry: TabEntry<SimulatorTabState>, resource: SimulatorTabResource): void {
    resource.dispose();
  },

  TabBarItem: SimulatorTabBarItem,
  TabBarItemDragPreview: SimulatorTabDragPreview,
  TabContent: SimulatorTabContent,
});
