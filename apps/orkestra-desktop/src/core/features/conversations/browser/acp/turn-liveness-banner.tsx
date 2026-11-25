import { Button } from '@orkestra/ui/react/primitives';
import { Hourglass, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { AcpChatStore } from './acp-chat-store';
import { assessTurnLiveness, formatSilence } from './turn-liveness';

const MAX_LISTED_TOOLS = 2;

/**
 * Says so when a running turn has gone quiet, instead of an endless "Çalışıyor…". It never stops
 * work by itself: long tools only get a description, a turn without running tools is reported as
 * probably stuck, and both offer Durdur / Tekrar dene.
 */
export const TurnLivenessBanner = observer(function TurnLivenessBanner({
  store,
}: {
  store: AcpChatStore;
}) {
  const isWorking = store.affordances.isWorking;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isWorking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [isWorking]);

  const liveness = assessTurnLiveness({
    isWorking,
    activity: store.turnActivity,
    observedActivityAt: store.observedActivityAt,
    activeTurn: store.liveTurn(),
    now,
  });
  if (liveness.kind === 'healthy') return null;

  const silence = formatSilence(liveness.silentForMs);
  const stalled = liveness.kind === 'stalled';
  const tools =
    liveness.kind === 'waiting-on-tools'
      ? liveness.tools.slice(0, MAX_LISTED_TOOLS).join(', ') +
        (liveness.tools.length > MAX_LISTED_TOOLS
          ? ` +${liveness.tools.length - MAX_LISTED_TOOLS}`
          : '')
      : '';
  const message = stalled
    ? `Ajandan ${silence} süredir yanıt gelmiyor ve çalışan bir araç yok; tur takılmış olabilir.`
    : `Ajan ${silence} süredir sessiz; çalışan araç bekleniyor: ${tools}. Yanıt, araç bitince gelir.`;

  return (
    <div
      role="status"
      className={
        stalled
          ? 'border-destructive/30 bg-destructive/5 mx-3 mb-1.5 flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs'
          : 'mx-3 mb-1.5 flex items-center justify-between gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-2.5 py-1.5 text-xs'
      }
    >
      <div className="flex min-w-0 items-center gap-2 text-foreground">
        {stalled ? (
          <TriangleAlert className="text-destructive h-3.5 w-3.5 shrink-0" />
        ) : (
          <Hourglass className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        )}
        <span className="truncate" title={message}>
          {message}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="secondary"
          size="xs"
          disabled={!store.affordances.canCancel}
          onClick={() => store.stop()}
        >
          Durdur
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          disabled={!store.affordances.canCancel}
          onClick={() => store.retryStalledTurn()}
        >
          Tekrar dene
        </Button>
      </div>
    </div>
  );
});
