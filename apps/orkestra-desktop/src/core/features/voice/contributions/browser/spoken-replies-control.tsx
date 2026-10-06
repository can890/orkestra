import { Button, Tooltip } from '@orkestra/ui/react/primitives';
import { LoaderCircle, Square, Volume2, VolumeX } from 'lucide-react';
import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import {
  finalAssistantText,
  latestSpeakableTurn,
  type SpeakableTurn,
} from '@core/features/voice/browser/final-assistant-text';
import { getSpokenRepliesStore } from '@core/features/voice/contributions/app-stores';

// Sohbet başlığındaki hoparlör anahtarı. Açıkken her turun son asistan mesajı tur bittiğinde
// sesli okunur; okuma sürerken durdurma düğmesi görünür. Varsayılan kapalıdır.

/** ACP sohbet deposunun bu bileşenin ihtiyaç duyduğu yapısal alt kümesi. */
export type SpokenRepliesSource = {
  readonly conversationId: string;
  readonly affordances: { readonly isWorking: boolean };
  readonly chatState: {
    readonly transcript: {
      readonly state: {
        readonly displayTurns: readonly SpeakableTurn[];
        readonly activeTurnSnapshot: SpeakableTurn | null;
      };
    };
  };
};

/** Tur kapanışından sonra son parçaların geçmişe işlenmesi için kısa bekleme. */
const SETTLE_DELAY_MS = 350;

function readLatestTurn(source: SpokenRepliesSource): SpeakableTurn | null {
  const { displayTurns, activeTurnSnapshot } = source.chatState.transcript.state;
  return latestSpeakableTurn(displayTurns, activeTurnSnapshot);
}

export const SpokenRepliesControl = observer(function SpokenRepliesControl({
  source,
}: {
  source: SpokenRepliesSource;
}) {
  const spoken = getSpokenRepliesStore();
  const { conversationId } = source;
  const enabled = spoken.isEnabled(conversationId);
  const playback = spoken.playback?.conversationId === conversationId ? spoken.playback : null;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const dispose = reaction(
      () => source.affordances.isWorking,
      (working, wasWorking) => {
        if (working || !wasWorking) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const turn = readLatestTurn(source);
          const text = finalAssistantText(turn);
          if (turn && text) spoken.speakTurn(conversationId, turn.id, text);
        }, SETTLE_DELAY_MS);
      }
    );
    return () => {
      dispose();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, source, conversationId, spoken]);

  const toggle = () => {
    const nowEnabled = spoken.toggle(conversationId);
    // Anahtar açılmadan önce tamamlanmış yanıt okunmasın.
    if (nowEnabled && !source.affordances.isWorking) {
      const turn = readLatestTurn(source);
      if (turn) spoken.markTurnSeen(conversationId, turn.id);
    }
  };

  const toggleLabel = enabled ? 'Sesli yanıtları kapat' : 'Yanıtları sesli oku';

  return (
    <div className="pointer-events-auto flex items-center gap-0.5 rounded-md bg-(--em-surface)/80 backdrop-blur-sm">
      {playback && (
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <Button
                variant="ghost"
                size="xs"
                icon
                aria-label="Okumayı durdur"
                onClick={() => spoken.stop()}
              >
                {playback.status === 'loading' ? (
                  <LoaderCircle className="animate-spin" aria-hidden />
                ) : (
                  <Square aria-hidden />
                )}
              </Button>
            }
          />
          <Tooltip.Content>
            {playback.status === 'loading' ? 'Ses hazırlanıyor… (durdur)' : 'Okumayı durdur'}
          </Tooltip.Content>
        </Tooltip.Root>
      )}
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              variant="ghost"
              size="xs"
              icon
              aria-label={toggleLabel}
              aria-pressed={enabled}
              onClick={toggle}
            >
              {enabled ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}
            </Button>
          }
        />
        <Tooltip.Content>{toggleLabel}</Tooltip.Content>
      </Tooltip.Root>
    </div>
  );
});
