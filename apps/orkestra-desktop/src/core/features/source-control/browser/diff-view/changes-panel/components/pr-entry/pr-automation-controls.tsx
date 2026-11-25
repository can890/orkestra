import { Switch, ToggleGroup, toast } from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import type { PrAutomationStore } from '@core/features/source-control/api/browser/stores/pr-automation-store';
import type { PrStore } from '@core/features/source-control/api/browser/stores/pr-store';
import {
  pullRequestProviderInfo,
  type PullRequest,
  type PullRequestMergeStrategy,
} from '@core/services/pull-requests/api';

const strategyLabels: Record<PullRequestMergeStrategy, string> = {
  merge: 'Merge',
  squash: 'Squash',
  rebase: 'Rebase',
};

const eventLabels = {
  sent: 'Gönderildi',
  'send-failed': 'Gönderilemedi',
  blocked: 'Durduruldu',
} as const;

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * PR otomasyonu anahtarları. İkisi de varsayılan kapalıdır ve yalnızca bu kontrollere tıklanarak
 * açılır: "Otomatik düzelt" ajana hata/yorum ayrıntısıyla prompt gönderir; "Kontroller geçince
 * birleştir" GitHub'ın yerel auto-merge özelliğini açar.
 */
export const PrAutomationControls = observer(function PrAutomationControls({
  pr,
  prStore,
  automation,
}: {
  pr: PullRequest;
  prStore: PrStore;
  automation: PrAutomationStore;
}) {
  const [strategy, setStrategy] = useState<PullRequestMergeStrategy>('merge');
  const [isTogglingMerge, setIsTogglingMerge] = useState(false);
  const activeStrategy = automation.autoMergeStrategyFor(pr.url);
  const autoMergeOn = activeStrategy !== null;
  const recentEvents = automation.events.slice(-3).reverse();
  const provider = pullRequestProviderInfo(pr.provider);

  const toggleAutoMerge = async (enabled: boolean) => {
    const used = activeStrategy ?? strategy;
    setIsTogglingMerge(true);
    try {
      const result = await prStore.setAutoMerge(pr.url, enabled, used);
      if (!result.success) {
        toast.error(
          enabled ? 'Otomatik birleştirme açılamadı' : 'Otomatik birleştirme kapatılamadı',
          { description: result.error }
        );
        return;
      }
      automation.setAutoMergeIntent(enabled ? { prUrl: pr.url, strategy: used } : null);
    } finally {
      setIsTogglingMerge(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border px-3 py-2.5">
      <label className="flex cursor-pointer items-start gap-2">
        <Switch
          className="mt-px"
          checked={automation.autoFix}
          onCheckedChange={(checked) => automation.setAutoFix(Boolean(checked))}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm leading-tight text-foreground">Otomatik düzelt</span>
          <span className="text-xs leading-snug text-foreground-muted">
            Kontroller başarısız olunca ya da yeni inceleme yorumu gelince ajana ayrıntılarıyla
            mesaj gönderir. Aynı commit için en fazla 3 deneme; ajan meşgulken beklenir.
          </span>
        </span>
      </label>
      {recentEvents.length > 0 && (
        <ul
          className="flex flex-col gap-0.5 text-xs text-foreground-muted"
          aria-label="Otomasyon geçmişi"
        >
          {recentEvents.map((event) => (
            <li key={`${event.at}-${event.kind}`} className="truncate">
              {formatTime(event.at)} · {eventLabels[event.kind]} · {event.summary}
            </li>
          ))}
        </ul>
      )}
      {pr.status === 'open' && !pr.isDraft && !provider.autoMerge && (
        <p className="text-xs leading-snug text-foreground-muted">
          {`"Kontroller geçince birleştir" yalnızca GitHub'da kullanılabilir; ${provider.name} için birleştirmeyi aşağıdan yapın.`}
        </p>
      )}
      {pr.status === 'open' && !pr.isDraft && provider.autoMerge && (
        <div className="flex flex-col gap-1.5">
          <label className="flex cursor-pointer items-start gap-2">
            <Switch
              className="mt-px"
              checked={autoMergeOn}
              disabled={isTogglingMerge}
              onCheckedChange={(checked) => void toggleAutoMerge(Boolean(checked))}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm leading-tight text-foreground">
                Kontroller geçince birleştir
              </span>
              <span className="text-xs leading-snug text-foreground-muted">
                GitHub&apos;ın yerel auto-merge özelliğini açar; gerekli kontroller ve incelemeler
                tamamlanınca PR&apos;ı GitHub birleştirir. Depoda auto-merge izinli olmalıdır.
              </span>
            </span>
          </label>
          <ToggleGroup.Root
            value={[activeStrategy ?? strategy]}
            className="flex w-full"
            onValueChange={([value]) => {
              if (value && !autoMergeOn) setStrategy(value as PullRequestMergeStrategy);
            }}
          >
            {(['merge', 'squash', 'rebase'] as const).map((value) => (
              <ToggleGroup.Item
                key={value}
                className="flex-1"
                value={value}
                disabled={autoMergeOn || isTogglingMerge}
              >
                {strategyLabels[value]}
              </ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>
        </div>
      )}
    </div>
  );
});
