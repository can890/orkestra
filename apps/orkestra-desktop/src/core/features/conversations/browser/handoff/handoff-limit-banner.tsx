import { Button } from '@orkestra/ui/react/primitives';
import { Clock, X } from 'lucide-react';
import { formatResetIn, type HandoffSuggestions } from './handoff-suggestions';

/**
 * Mesaj kutusunun üstündeki kapatılabilir limit şeridi. Başka ajana geçiş önerebildiği gibi
 * sıfırlanma saati belliyse "Sıfırlanınca otomatik devam et" anahtarı da sunar.
 */
export function HandoffLimitBanner({
  agentLabel,
  reason,
  resetsAt,
  now,
  suggestions,
  autoResumeActive = false,
  autoResumeCountdown,
  onToggleAutoResume,
  onPick,
  onMore,
  onDismiss,
}: {
  agentLabel: string;
  reason: 'saturated' | 'turn-error';
  resetsAt: string | undefined;
  now: number;
  suggestions: HandoffSuggestions;
  autoResumeActive?: boolean;
  autoResumeCountdown?: string | null;
  onToggleAutoResume?: () => void;
  onPick: (agentId: string) => void;
  onMore: () => void;
  onDismiss: () => void;
}) {
  const reset = formatResetIn(resetsAt, now);
  return (
    <div
      role="status"
      className="mx-3 mb-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border-warning bg-background-warning/30 px-3 py-2 text-xs"
    >
      <div className="min-w-0 flex-1 basis-48">
        <p className="font-medium text-foreground">{agentLabel} kullanım limiti doldu</p>
        <p className="text-foreground-muted">
          {autoResumeActive && autoResumeCountdown
            ? `${autoResumeCountdown} sonra otomatik devam edilecek.`
            : reset
              ? `${reset} sonra yenilenir. `
              : ''}
          {!autoResumeActive && reason === 'turn-error' && !reset
            ? 'Son istek limit hatasıyla bitti. '
            : ''}
          {!autoResumeActive ? 'İşe başka bir ajanla devam edebilirsiniz.' : ''}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {resetsAt && onToggleAutoResume && (
          <Button
            type="button"
            size="sm"
            variant={autoResumeActive ? 'primary' : 'secondary'}
            onClick={onToggleAutoResume}
            className="gap-1"
          >
            <Clock className="size-3.5" />
            {autoResumeActive ? 'Otomatik devam açık' : 'Sıfırlanınca devam et'}
          </Button>
        )}
        {suggestions.buttons.map((agent) => (
          <Button
            key={agent.id}
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => onPick(agent.id)}
          >
            {agent.name} ile devam et
          </Button>
        ))}
        {suggestions.moreCount > 0 ? (
          <Button type="button" size="sm" variant="ghost" onClick={onMore}>
            Diğerleri…
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          icon
          aria-label="Limit bildirimini kapat"
          onClick={onDismiss}
        >
          <X />
        </Button>
      </div>
    </div>
  );
}
