import { Button } from '@orkestra/ui/react/primitives';
import { Loader2, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import {
  formatResetCreditExpiry,
  formatUsagePercent,
} from '@core/features/usage-limits/browser/usage-format';

/**
 * Mesaj kutusunun üstündeki kapatılabilir sıfırlama hakkı öneri şeridi.
 * Aktif yapay zekanın kullanım limiti bitmek üzereyken (>= %80) veya dolduğunda
 * kullanılabilir sıfırlama hakkı varsa kullanıcıya bunu tek yerden kullanma imkânı verir.
 */
export function ResetCreditBanner({
  agentLabel,
  reason,
  usedPercent,
  availableCount,
  expiresAt,
  now,
  isRedeeming = false,
  onRedeem,
  onDismiss,
}: {
  agentLabel: string;
  reason: 'approaching' | 'saturated' | 'turn-error';
  usedPercent: number | null;
  availableCount: number;
  expiresAt?: string;
  now: number;
  isRedeeming?: boolean;
  onRedeem: () => Promise<void> | void;
  onDismiss: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const expiryText = formatResetCreditExpiry(expiresAt, now);

  const heading =
    reason === 'approaching'
      ? `${agentLabel} kullanım limiti bitmek üzere${usedPercent !== null ? ` (${formatUsagePercent(usedPercent)})` : ''}`
      : `${agentLabel} kullanım limiti doldu`;

  return (
    <div
      role="status"
      className="mx-3 mb-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border-warning bg-background-warning/30 px-3 py-2 text-xs"
    >
      <div className="min-w-0 flex-1 basis-48">
        <p className="font-medium text-foreground">{heading}</p>
        <p className="text-foreground-muted">
          Kullanılabilir {availableCount} sıfırlama hakkınız var
          {expiryText ? ` (son kullanma: ${expiryText})` : ''}. Dilerseniz şimdi limitinizi
          sıfırlayabilirsiniz.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {confirming ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={isRedeeming}
              onClick={() => {
                setConfirming(false);
                void onRedeem();
              }}
              className="gap-1"
            >
              {isRedeeming ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Sıfırlanıyor…
                </>
              ) : (
                'Evet, sıfırla'
              )}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isRedeeming}
              onClick={() => setConfirming(false)}
            >
              Vazgeç
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={isRedeeming}
            onClick={() => setConfirming(true)}
            className="gap-1"
          >
            {isRedeeming ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Sıfırlanıyor…
              </>
            ) : (
              <>
                <RotateCcw className="size-3.5" />
                Sıfırlama hakkını kullan
              </>
            )}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          icon
          aria-label="Sıfırlama önerisini kapat"
          onClick={onDismiss}
        >
          <X />
        </Button>
      </div>
    </div>
  );
}
