import { Badge, Button, toast } from '@orkestra/ui/react/primitives';
import { Loader2, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import type {
  ConsumeResetCreditResult,
  ProviderUsage,
} from '@core/features/usage-limits/api/usage-limits';
import { cn } from '@core/primitives/styling/browser/cn';
import { formatResetCreditExpiry, getActiveResetCredits } from './usage-format';

/**
 * Sağlayıcının kullanılabilir limit sıfırlama haklarını, son kullanma tarihlerini ve
 * 2 adımlı onaylı "Sıfırlama hakkını kullan" aksiyonunu gösterir.
 */
export function ResetCreditSection({
  usage,
  now,
  compact = false,
  isRedeeming = false,
  onRedeem,
}: {
  usage: ProviderUsage;
  now: number;
  compact?: boolean;
  isRedeeming?: boolean;
  onRedeem?: (creditId?: string) => Promise<ConsumeResetCreditResult>;
}) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: 'success' | 'info' | 'error';
    message: string;
  } | null>(null);

  const summary = getActiveResetCredits(usage, now);
  if (summary.count <= 0) return null;

  const targetCredit = summary.nextExpiring;
  const confirmKey = targetCredit?.id ?? '__next__';
  const isConfirming = confirmingId === confirmKey;

  const handleConfirm = async (creditId?: string) => {
    if (!onRedeem || isRedeeming) return;
    setFeedback(null);
    try {
      const result = await onRedeem(creditId);
      setConfirmingId(null);
      if (result.outcome === 'reset') {
        toast.success(result.message);
      } else if (result.outcome === 'error' || result.outcome === 'unsupported') {
        toast.error(result.message);
        setFeedback({ tone: 'error', message: result.message });
      } else {
        toast(result.message);
        setFeedback({ tone: 'info', message: result.message });
      }
    } catch {
      setConfirmingId(null);
      const message = 'Limit sıfırlama hakkı kullanılırken bir hata oluştu.';
      toast.error(message);
      setFeedback({ tone: 'error', message });
    }
  };

  const primaryExpiry = formatResetCreditExpiry(targetCredit?.expiresAt, now);
  const extraCredits = summary.credits.slice(1);

  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/[0.06]',
        compact ? 'px-2 py-1.5' : 'px-3 py-2'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[11.5px] font-medium text-foreground">
          <RotateCcw className="size-3.5 shrink-0 text-emerald-500" aria-hidden />
          <span className="truncate">Limit sıfırlama hakkı</span>
        </span>
        <Badge variant="outline" className="shrink-0 tabular-nums">
          {summary.count} adet
        </Badge>
      </div>

      {primaryExpiry ? (
        <span className="text-[11px] text-foreground-muted">
          Son kullanma: <span className="text-foreground">{primaryExpiry}</span>
        </span>
      ) : (
        <span className="text-[11px] text-foreground-muted">
          Kullanılabilir sıfırlama hakkı mevcut.
        </span>
      )}

      {!compact && targetCredit?.description && (
        <span className="text-[11px] text-foreground-muted">{targetCredit.description}</span>
      )}

      {!compact && extraCredits.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-border/40 pt-1">
          {extraCredits.map((credit) => {
            const exp = formatResetCreditExpiry(credit.expiresAt, now);
            return (
              <span key={credit.id} className="text-[11px] text-foreground-muted">
                {credit.title || 'Sıfırlama hakkı'}
                {exp ? ` · Son kullanma: ${exp}` : ''}
              </span>
            );
          })}
        </div>
      )}

      {summary.canRedeem && onRedeem && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {isConfirming ? (
            <>
              <span className="text-[11px] text-foreground">Limit şimdi sıfırlansın mı?</span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant="primary"
                  disabled={isRedeeming}
                  onClick={() => void handleConfirm(targetCredit?.id)}
                >
                  {isRedeeming ? (
                    <>
                      <Loader2 className="size-3 animate-spin" />
                      Sıfırlanıyor…
                    </>
                  ) : (
                    'Evet, sıfırla'
                  )}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={isRedeeming}
                  onClick={() => setConfirmingId(null)}
                >
                  Vazgeç
                </Button>
              </div>
            </>
          ) : (
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={isRedeeming}
              onClick={() => {
                setFeedback(null);
                setConfirmingId(confirmKey);
              }}
              className="gap-1"
            >
              {isRedeeming ? (
                <>
                  <Loader2 className="size-3 animate-spin" />
                  Sıfırlanıyor…
                </>
              ) : (
                <>
                  <RotateCcw className="size-3" />
                  Sıfırlama hakkını kullan
                </>
              )}
            </Button>
          )}
        </div>
      )}

      {feedback && (
        <span
          className={cn(
            'text-[11px]',
            feedback.tone === 'error' ? 'text-foreground-destructive' : 'text-foreground-muted'
          )}
        >
          {feedback.message}
        </span>
      )}
    </div>
  );
}
