import { useEffect, useState } from 'react';
import type { ConversationStore } from '@core/features/conversations/api/browser/conversation-manager';
import {
  executeConversationViewSwitch,
  retryConversationPtyHydration,
} from '@core/features/conversations/api/browser/conversation-view-switch';
import { canSwitchConversationView } from '@core/features/conversations/api/view-switch';
import type { TabHost } from '@core/primitives/workbench-shell/browser/tabs/core/tab-host';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';

export function useConversationViewSwitch(
  store: ConversationStore | undefined,
  host: TabHost,
  tabId: string,
  currentType: 'pty' | 'acp'
) {
  const { paneId } = usePaneContext();
  const [pending, setPending] = useState(false);
  const type = store?.data.type ?? 'pty';
  useEffect(() => {
    if (!store || type === currentType) return;
    // Panelin son sekmesini değiştirirken panelin kapanmaması için önce yeni görünümü aç.
    host.openKind(
      type === 'acp' ? 'acp-chat' : 'conversation',
      { conversationId: store.data.id },
      { target: { paneId }, preview: false }
    );
    host.closeTab(tabId);
    if (type === 'pty') retryConversationPtyHydration(store.data.taskId, store.data.id);
  }, [store, type, currentType, host, tabId, paneId]);

  const switchView = async (stopUnobservedTerminal = false) => {
    if (!store || pending) return;
    setPending(true);
    try {
      await executeConversationViewSwitch(store, currentType === 'pty' ? 'acp' : 'pty', {
        stopUnobservedTerminal,
      });
    } finally {
      setPending(false);
    }
  };

  return {
    id: 'conversation:switch-view',
    label: pending
      ? 'Görünüm değiştiriliyor…'
      : currentType === 'pty'
        ? 'Sohbet görünümüne geç'
        : 'Terminal görünümüne geç',
    group: 'view',
    // Sağlayıcının gerçek oturum kimliği bilinmeden geçiş çalışamaz; eylem o zamana kadar gizlenir.
    isAvailable: () =>
      Boolean(
        store &&
        canSwitchConversationView(store.data.providerId, store.data.id, store.data.sessionId)
      ),
    run: () => switchView(),
  };
}
