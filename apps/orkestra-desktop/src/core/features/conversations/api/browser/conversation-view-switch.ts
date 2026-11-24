import { toast } from '@orkestra/ui/react/primitives';
import { runInAction } from 'mobx';
import { useState } from 'react';
import {
  canSwitchConversationView,
  supportsConversationViewSwitch,
} from '@core/features/conversations/api/view-switch';
import { getConversationSessionManager } from '@core/features/conversations/browser/stores/conversation-session-manager';
import type { Conversation } from '@core/primitives/conversations/api';
import { getConversationsClient } from './client';
import type { ConversationStore } from './conversation-manager';
import { isSupersededConversation } from './handoff-visibility';
import { conversationRegistry } from './stores/conversation-registry';

export interface ExecuteConversationViewSwitchOptions {
  stopUnobservedTerminal?: boolean;
  onSwitched?: (updated: Conversation) => void;
}

export interface TaskViewSwitchMenuAction {
  targetType: 'pty' | 'acp';
  label: string;
  disabled?: boolean;
  disabledReason?: string;
  onSwitch: () => void;
}

/**
 * Konuşmanın görünümünü sohbet (`acp`) ile terminal (`pty`) arasında değiştirir ve sonucu
 * yerel ConversationStore üzerine uygular.
 */
export async function executeConversationViewSwitch(
  store: ConversationStore,
  targetType: 'pty' | 'acp',
  options?: ExecuteConversationViewSwitchOptions
): Promise<boolean> {
  try {
    const result = await (
      await getConversationsClient()
    ).switchView({
      conversationId: store.data.id,
      type: targetType,
      ...(options?.stopUnobservedTerminal ? { stopUnobservedTerminal: true } : {}),
    });
    if (!result.success) {
      if (result.error.canStopTerminal) {
        toast.error('Sohbete dönüş için terminali durdurun', {
          description: result.error.message,
          duration: Infinity,
          action: {
            label: 'Durdur ve sohbete geç',
            onClick: () =>
              void executeConversationViewSwitch(store, targetType, {
                ...options,
                stopUnobservedTerminal: true,
              }),
          },
        });
        return false;
      }
      throw new Error(result.error.message);
    }
    runInAction(() => {
      store.data = result.data;
    });
    options?.onSwitched?.(result.data);
    return true;
  } catch (error) {
    toast.error('Görünüm değiştirilemedi', {
      description: error instanceof Error ? error.message : undefined,
    });
    return false;
  }
}

function interactionTimeMs(store: ConversationStore): number {
  const raw = store.data.lastInteractedAt;
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Bir görev altında görünüm geçişi için en uygun (superseded olmayan) konuşmayı seçer.
 * Önce açık sekmelerdeki `preferredConversationIds` adaylarına bakar, yoksa kayıtlı oturumu
 * hazır ve en son etkileşim görmüş konuşmayı döndürür.
 */
export function resolveTaskSwitchableConversation(
  taskId: string,
  preferredConversationIds: readonly string[] = []
): ConversationStore | undefined {
  const manager = conversationRegistry.get(taskId);
  if (!manager) return undefined;

  for (const preferredId of preferredConversationIds) {
    if (!preferredId || isSupersededConversation(preferredId)) continue;
    const match = manager.conversations.get(preferredId);
    if (match) return match;
  }

  const candidates = Array.from(manager.conversations.values()).filter(
    (c) => !isSupersededConversation(c.data.id)
  );
  if (candidates.length === 0) return undefined;

  const ranked = candidates
    .map((candidate, index) => {
      const canNow = canSwitchConversationView(
        candidate.data.providerId,
        candidate.data.id,
        candidate.data.sessionId
      );
      const supports = supportsConversationViewSwitch(candidate.data.providerId);
      const tier = canNow ? 2 : supports ? 1 : 0;
      return {
        candidate,
        index,
        tier,
        time: interactionTimeMs(candidate),
        initial: candidate.data.isInitialConversation ? 1 : 0,
      };
    })
    .sort((a, b) => {
      if (b.tier !== a.tier) return b.tier - a.tier;
      if (b.time !== a.time) return b.time - a.time;
      if (b.initial !== a.initial) return b.initial - a.initial;
      return b.index - a.index;
    });

  return ranked[0]?.candidate;
}

/**
 * Verilen görev için sağ tık menüsünde gösterilecek "Terminal moduna geç" / "Sohbet moduna geç"
 * aksiyonunu hazırlar.
 */
export function useTaskViewSwitchAction({
  taskId,
  preferredConversationIds,
  disabledReason,
  onSwitched,
}: {
  taskId: string;
  preferredConversationIds?: readonly string[];
  disabledReason?: string | null;
  onSwitched?: (updated: Conversation) => void;
}): TaskViewSwitchMenuAction | undefined {
  const [switchingView, setSwitchingView] = useState(false);
  const target = resolveTaskSwitchableConversation(taskId, preferredConversationIds);
  if (!target || !supportsConversationViewSwitch(target.data.providerId)) {
    return undefined;
  }

  const currentType = target.data.type ?? 'pty';
  const targetType: 'pty' | 'acp' = currentType === 'acp' ? 'pty' : 'acp';
  const canSwitch = canSwitchConversationView(
    target.data.providerId,
    target.data.id,
    target.data.sessionId
  );

  return {
    targetType,
    label: switchingView
      ? 'Görünüm değiştiriliyor…'
      : targetType === 'pty'
        ? 'Terminal moduna geç'
        : 'Sohbet moduna geç',
    disabled: switchingView || !canSwitch || Boolean(disabledReason),
    disabledReason:
      disabledReason ??
      (!canSwitch
        ? 'Önce sohbette bir mesaj başlatın; oturum kimliği oluşunca geçiş açılır.'
        : undefined),
    onSwitch: () => {
      if (switchingView) return;
      setSwitchingView(true);
      void executeConversationViewSwitch(target, targetType, { onSwitched }).finally(() =>
        setSwitchingView(false)
      );
    },
  };
}

export function collectOpenConversationIds(
  paneLayout:
    | {
        focusedPane?: { resolvedActiveTabId?: string; entries: ReadonlyMap<string, { kind: string; state?: unknown }> };
        groups: ReadonlyArray<{
          pane: {
            resolvedActiveTabId?: string;
            tabOrder: readonly string[];
            entries: ReadonlyMap<string, { kind: string; state?: unknown }>;
          };
        }>;
      }
    | undefined
): string[] {
  if (!paneLayout) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  const pushFromEntry = (entry: { kind: string; state?: unknown } | undefined) => {
    if (!entry || (entry.kind !== 'acp-chat' && entry.kind !== 'conversation')) return;
    const convId = (entry.state as { conversationId?: string } | undefined)?.conversationId;
    if (!convId || seen.has(convId)) return;
    seen.add(convId);
    ids.push(convId);
  };

  if (paneLayout.focusedPane) {
    const activeId = paneLayout.focusedPane.resolvedActiveTabId;
    if (activeId) pushFromEntry(paneLayout.focusedPane.entries.get(activeId));
  }
  for (const group of paneLayout.groups) {
    const activeId = group.pane.resolvedActiveTabId;
    if (activeId) pushFromEntry(group.pane.entries.get(activeId));
    for (const tabId of group.pane.tabOrder) {
      pushFromEntry(group.pane.entries.get(tabId));
    }
  }
  return ids;
}

/** Terminal görünümüne dönüldüğünde ilgili PTY oturumunun yeniden bağlanmasını tetikler. */
export function retryConversationPtyHydration(taskId: string, conversationId: string): void {
  getConversationSessionManager(taskId).retryHydration(conversationId);
}
