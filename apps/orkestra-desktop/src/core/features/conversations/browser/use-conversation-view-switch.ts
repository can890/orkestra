import { toast } from '@orkestra/ui/react/primitives';
import { runInAction } from 'mobx';
import { useEffect, useState } from 'react';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import type { ConversationStore } from '@core/features/conversations/api/browser/conversation-manager';
import { supportsConversationViewSwitch } from '@core/features/conversations/api/view-switch';
import type { TabHost } from '@core/primitives/workbench-shell/browser/tabs/core/tab-host';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';
import { getConversationSessionManager } from './stores/conversation-session-manager';

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
    if (type === 'pty')
      getConversationSessionManager(store.data.taskId).retryHydration(store.data.id);
  }, [store, type, currentType, host, tabId, paneId]);

  return {
    id: 'conversation:switch-view',
    label: pending
      ? 'Görünüm değiştiriliyor…'
      : currentType === 'pty'
        ? 'Sohbet görünümüne geç'
        : 'Terminal görünümüne geç',
    group: 'view',
    isAvailable: () => Boolean(store && supportsConversationViewSwitch(store.data.providerId)),
    run: async () => {
      if (!store || pending) return;
      setPending(true);
      try {
        const result = await (
          await getConversationsClient()
        ).switchView({
          conversationId: store.data.id,
          type: currentType === 'pty' ? 'acp' : 'pty',
        });
        if (!result.success) throw new Error(result.error.message);
        runInAction(() => {
          store.data = result.data;
        });
      } catch (error) {
        toast.error('Görünüm değiştirilemedi', {
          description: error instanceof Error ? error.message : undefined,
        });
      } finally {
        setPending(false);
      }
    },
  };
}
