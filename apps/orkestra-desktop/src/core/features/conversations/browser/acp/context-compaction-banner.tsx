import { Button } from '@orkestra/ui/react/primitives';
import { Gauge, Minimize2, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import type { AcpChatStore } from './acp-chat-store';

interface ContextCompactionBannerProps {
  store: AcpChatStore;
  onCompact: () => void;
}

export const ContextCompactionBanner = observer(function ContextCompactionBanner({
  store,
  onCompact,
}: ContextCompactionBannerProps) {
  const { value: chatSettings } = useAppSettingsKey('chat');
  const enabled = chatSettings?.showContextCompactionBanner ?? true;
  const expiryMinutes = chatSettings?.cacheExpiryWarningMinutes ?? 4;

  const isWorking = store.affordances.isWorking;
  const turnCount = store.visibleTurns().length;
  const usage = store.usage;
  const contextRatio =
    usage && usage.contextSize > 0 ? usage.contextUsed / usage.contextSize : 0;

  const [idleSince, setIdleSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    if (isWorking || turnCount < 4) {
      setIdleSince(null);
      return;
    }
    setIdleSince((prev) => prev ?? Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [isWorking, turnCount, store.conversationId]);

  if (!enabled || isWorking) return null;

  const isHighContext = contextRatio >= 0.75;
  const isCacheWarmthExpiring =
    idleSince !== null && turnCount >= 4 && now - idleSince >= expiryMinutes * 60_000;

  if (!isHighContext && !isCacheWarmthExpiring) return null;

  const bannerKey = `${store.conversationId}:${isHighContext ? 'ctx' : 'cache'}:${turnCount}`;
  if (dismissedKey === bannerKey) return null;

  const percentText = Math.round(contextRatio * 100);
  const idleMinutes = idleSince ? Math.max(1, Math.floor((now - idleSince) / 60_000)) : expiryMinutes;

  return (
    <div className="mx-3 mb-1.5 flex items-center justify-between gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-2.5 py-1.5 text-xs">
      <div className="flex min-w-0 items-center gap-2 text-foreground">
        <Gauge className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="truncate">
          {isHighContext
            ? `Bağlam penceresi %${percentText} dolu — yanıt hızını ve maliyeti korumak için sıkıştırabilirsiniz.`
            : `${idleMinutes} dk hareketsizlik: prompt önbelleği (cache) soğumak üzere — bağlamı sıkıştırmayı düşünün.`}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" variant="secondary" size="xs" onClick={onCompact}>
          <Minimize2 className="h-3 w-3" />
          Bağlamı Sıkıştır (/compact)
        </Button>
        <button
          type="button"
          onClick={() => setDismissedKey(bannerKey)}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Bağlam uyarısını kapat"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
});
