import type { HostRef } from '@orkestra/core/primitives/host/api';
import { toast } from '@orkestra/ui/react/primitives';
import { useCallback } from 'react';
import {
  decideResetCreditPrompt,
  type ResetCreditPromptDecision,
} from '@core/features/usage-limits/api/usage-capacity';
import { INDICATOR_USAGE_PROVIDERS } from '@core/features/usage-limits/api/usage-limits';
import { formatResetCreditExpiry } from '@core/features/usage-limits/browser/usage-format';
import {
  useConsumeResetCredit,
  useMinuteClock,
  useUsageLimits,
} from '@core/features/usage-limits/browser/use-usage-limits';

export type ProviderResetCreditState = {
  prompt: ResetCreditPromptDecision;
  expiryText: string | null;
  isRedeeming: boolean;
  redeem: () => Promise<void>;
};

/**
 * Aktif sağlayıcının limit sıfırlama hakkı öneri durumunu ve tüketim aksiyonunu
 * diğer özelliklere (`conversations` vb.) modül sınırlarını koruyarak sunar.
 */
export function useProviderResetCredit(
  host: HostRef,
  providerId: string | null,
  options: { enabled?: boolean; limitErrorTurnId?: string | null } = {}
): ProviderResetCreditState {
  const now = useMinuteClock();
  const { snapshot } = useUsageLimits(host, INDICATOR_USAGE_PROVIDERS, {
    enabled: (options.enabled ?? true) && Boolean(providerId),
  });
  const { consumeResetCredit, redeemingProviderId } = useConsumeResetCredit(host);

  const usage = providerId
    ? (snapshot?.providers.find((item) => item.providerId === providerId) ?? null)
    : null;

  const prompt = decideResetCreditPrompt({
    usage,
    limitErrorTurnId: options.limitErrorTurnId,
    now,
  });

  const expiryText = prompt.show ? formatResetCreditExpiry(prompt.nextExpiresAt, now) : null;

  const redeem = useCallback(async () => {
    if (!providerId) return;
    const creditId = prompt.show ? prompt.nextCreditId : undefined;
    try {
      const result = await consumeResetCredit({ providerId, creditId });
      if (result.outcome === 'reset') {
        toast.success(result.message);
      } else if (result.outcome === 'error' || result.outcome === 'unsupported') {
        toast.error(result.message);
      } else {
        toast(result.message);
      }
    } catch {
      toast.error('Limit sıfırlama hakkı kullanılırken bir hata oluştu.');
    }
  }, [providerId, prompt, consumeResetCredit]);

  return {
    prompt,
    expiryText,
    isRedeeming: Boolean(providerId && redeemingProviderId === providerId),
    redeem,
  };
}
