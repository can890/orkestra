import { Toaster } from '@orkestra/ui/react/primitives';
import { BrowserWebviewLayer } from '@core/features/browser/browser/browser-webview-layer';
import { HistorySwipeNavigation } from '@core/features/workbench/browser/history-swipe-navigation';
import { QuitHoldOverlay } from '@core/features/workbench/browser/quit-hold-overlay';
import { LeftSidebar } from '@core/features/workbench/browser/sidebar/left-sidebar';
import { MainDropZone } from '@core/features/workbench/browser/sidebar/sidebar-drop-overlay';
import { WindowScope } from '@core/features/workbench/browser/window-scope';
import {
  useWorkspaceSlots,
  useWorkspaceViewParams,
} from '@core/primitives/navigation/browser/navigation-hooks';
import { useTheme } from '@core/primitives/theme/browser';
import { BrowserShortcutForwarding, KeybindingDispatcherMount } from '@renderer/lib/keybindings';
import { WorkspaceContentLayout, WorkspaceLayout } from '@renderer/lib/layout/workspace-layout';

export function Workspace() {
  useTheme();
  const { WrapView, TitlebarSlot, MainPanel } = useWorkspaceSlots();
  const { params } = useWorkspaceViewParams();

  return (
    <WindowScope>
      <BrowserShortcutForwarding />
      <KeybindingDispatcherMount />
      <WorkspaceLayout
        leftSidebar={<LeftSidebar />}
        mainContent={
          <MainDropZone>
            <WrapView {...params}>
              <WorkspaceContentLayout titlebarSlot={<TitlebarSlot />} mainPanel={<MainPanel />} />
            </WrapView>
          </MainDropZone>
        }
      />
      {/* Browser pages live outside the per-view tree so they survive task switches. */}
      <BrowserWebviewLayer />
      <HistorySwipeNavigation />
      <QuitHoldOverlay />
      <Toaster />
    </WindowScope>
  );
}
