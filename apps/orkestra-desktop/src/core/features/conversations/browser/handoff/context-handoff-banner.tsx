import { Button } from '@orkestra/ui/react/primitives';
import { AlertTriangle, ArrowRightLeft, Loader2, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useSyncExternalStore } from 'react';
import { formatConversationTitleForDisplay } from '@core/features/conversations/api/browser/conversation-title-utils';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import {
  arrangeComposerBanners,
  clampContextHandoffThreshold,
  decideContextHandoffBanner,
  reconcileContextHandoffDismissals,
} from '@core/features/conversations/api/context-handoff-policy';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import type { AcpChatStore } from '../acp/acp-chat-store';
import { getContextHandoffDismissalStore } from './context-handoff-dismissal-store';
import { moveConversationToNewContext, openConversationBeside } from './context-handoff-runtime';
import { getContextHandoffCoordinator, type ContextHandoffPhase } from './context-handoff-service';
import { getHandoffStore } from './handoff-store';

const BASE =
  'mx-3 mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2.5 py-1.5 text-xs';
const CALM = `${BASE} border-border bg-foreground/[0.03]`;
const STRONG = `${BASE} border-border-warning bg-background-warning/30`;

function inFlightText(phase: ContextHandoffPhase): string {
  switch (phase.kind) {
    case 'waiting-turn':
      return 'Tur bitince yeni sohbete taşınacak.';
    case 'briefing':
      return 'Ajan devir notunu yazıyor; bitince yeni sohbet açılacak.';
    default:
      return 'Yeni sohbet hazırlanıyor…';
  }
}

/**
 * Mesaj kutusunun üstündeki bağlam devri şeridi. Üç hâli vardır: öneri ("Bağlam dolmak üzere"),
 * süren taşıma ve "Bu sohbet şuraya taşındı". Hangisinin (ve limit şeridiyle birlikte gösterilip
 * gösterilmeyeceğinin) kararı `context-handoff-policy.ts` içindeki saf kurallardadır.
 */
export const ContextHandoffBanner = observer(function ContextHandoffBanner({
  store,
  limitBannerVisible,
  providerLabel,
}: {
  store: AcpChatStore;
  limitBannerVisible: boolean;
  providerLabel?: string | undefined;
}) {
  const { value: chatSettings } = useAppSettingsKey('chat');
  const enabled = chatSettings?.contextHandoffSuggestion ?? true;
  const threshold = clampContextHandoffThreshold(chatSettings?.contextHandoffThreshold);
  const conversationId = store.conversationId;

  const coordinator = getContextHandoffCoordinator();
  const phase = useSyncExternalStore(
    (listener) => coordinator.subscribe(listener),
    () => coordinator.phase(conversationId)
  );
  const handoffStore = getHandoffStore();
  const successorId = useSyncExternalStore(
    (listener) => handoffStore.subscribe(listener),
    () => handoffStore.findContextSuccessor(conversationId)
  );
  const dismissalStore = getContextHandoffDismissalStore();
  const dismissed = useSyncExternalStore(
    (listener) => dismissalStore.subscribe(listener),
    () => dismissalStore.get(conversationId)
  );

  const usage = store.usage
    ? { used: store.usage.contextUsed, size: store.usage.contextSize }
    : null;
  const usageFresh = store.liveActionsEnabled && store.historyKnown && !store.historyLoading;

  // Bağlam sıkıştırılıp doluluk belirgin biçimde düşünce "Şimdi değil" kayıtları sıfırlanır.
  const usedTokens = usage?.used;
  const sizeTokens = usage?.size;
  useEffect(() => {
    if (!usageFresh || usedTokens === undefined || sizeTokens === undefined) return;
    const next = reconcileContextHandoffDismissals(
      dismissed,
      { used: usedTokens, size: sizeTokens },
      threshold
    );
    if (next !== dismissed) dismissalStore.set(conversationId, next);
  }, [usageFresh, usedTokens, sizeTokens, threshold, dismissed, dismissalStore, conversationId]);

  const inFlight = coordinator.isInFlight(conversationId);
  const decision = decideContextHandoffBanner({
    enabled,
    thresholdPercent: threshold,
    usage,
    usageFresh,
    dismissed,
    hasMessages: store.messageCount > 0 || store.prefixTurnCount > 0,
    hasSuccessor: successorId !== undefined,
    inFlight,
  });
  const layout = arrangeComposerBanners({
    limit: limitBannerVisible,
    handoffInFlight: inFlight,
    handoffSuggestion: decision.show,
    handoffMoved: successorId !== undefined && !dismissed.includes('moved'),
  });

  if (layout.handoff === 'in-flight' && phase) {
    const cancellable = phase.kind === 'waiting-turn' || phase.kind === 'briefing';
    return (
      <div role="status" className={`@container ${CALM}`}>
        <Loader2 className="size-3.5 shrink-0 animate-spin text-foreground-muted" aria-hidden />
        <span className="min-w-0 flex-1 basis-40 text-foreground">{inFlightText(phase)}</span>
        {cancellable ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => coordinator.cancel(conversationId)}
            title="Taşımadan vazgeç; çalışan tur durdurulmaz"
          >
            Vazgeç
          </Button>
        ) : null}
      </div>
    );
  }

  if (layout.handoff === 'suggestion' && decision.show) {
    const critical = decision.step === 'critical';
    const working = store.affordances.isWorking;
    const queued = store.queuedPrompts.length;
    const message = critical
      ? `Bağlam neredeyse dolu (%${decision.percent}). Kalite düşmeden konuyu yeni sohbete taşıyalım mı?`
      : `Bağlam dolmak üzere (%${decision.percent}). Konuyu yeni sohbete taşıyalım mı?`;
    return (
      <div role="status" className={`@container ${critical ? STRONG : CALM}`}>
        {critical ? (
          <AlertTriangle
            className="size-3.5 shrink-0 text-foreground-warning @max-[300px]:hidden"
            aria-hidden
          />
        ) : (
          <ArrowRightLeft
            className="size-3.5 shrink-0 text-foreground-muted @max-[300px]:hidden"
            aria-hidden
          />
        )}
        <span className="min-w-0 flex-1 basis-48 text-foreground">
          {message}
          {working ? (
            <span className="text-foreground-muted @max-[380px]:hidden">
              {' '}
              Ajan çalışıyor; tur bitince taşınır
              {queued > 0 ? `, sıradaki ${queued} mesaj da yeni sohbete geçer` : ''}.
            </span>
          ) : null}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant={critical ? 'primary' : 'secondary'}
            onClick={() => void moveConversationToNewContext(store, { providerLabel })}
          >
            {working ? 'Tur bitince taşı' : 'Yeni sohbete taşı'}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => dismissalStore.add(conversationId, decision.step)}
          >
            Şimdi değil
          </Button>
        </div>
      </div>
    );
  }

  if (layout.handoff === 'moved' && successorId) {
    const successor = conversationRegistry.get(store.taskId)?.conversations.get(successorId)?.data;
    const successorTitle = successor
      ? formatConversationTitleForDisplay(successor.providerId, successor.title)
      : 'yeni sohbet';
    return (
      <div role="status" className={`@container ${CALM}`}>
        <ArrowRightLeft className="size-3.5 shrink-0 text-foreground-muted" aria-hidden />
        <span className="min-w-0 flex-1 basis-40 truncate text-foreground">
          Bu sohbet şuraya taşındı: {successorTitle}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="secondary"
            onClick={() =>
              openConversationBeside({
                projectId: store.projectId,
                taskId: store.taskId,
                sourceConversationId: conversationId,
                conversationId: successorId,
              })
            }
          >
            Yeni sohbeti aç
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            icon
            aria-label="Taşındı bildirimini kapat"
            onClick={() => dismissalStore.add(conversationId, 'moved')}
          >
            <X />
          </Button>
        </div>
      </div>
    );
  }

  return null;
});
