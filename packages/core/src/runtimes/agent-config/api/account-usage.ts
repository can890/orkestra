import { z } from 'zod';

export const accountUsageResetCreditSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  grantedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  status: z.enum(['available', 'redeeming', 'redeemed', 'unknown']).optional(),
});
export type AccountUsageResetCredit = z.infer<typeof accountUsageResetCreditSchema>;

export const accountUsageResetCreditsSchema = z.object({
  availableCount: z.number().int().nonnegative(),
  /** Uygulama içinden doğrudan sıfırlama hakkı tüketilebiliyor mu. */
  canRedeem: z.boolean().optional(),
  credits: z.array(accountUsageResetCreditSchema),
});
export type AccountUsageResetCredits = z.infer<typeof accountUsageResetCreditsSchema>;

export const consumeAccountUsageResetCreditOutcomeSchema = z.enum([
  'reset',
  'nothingToReset',
  'noCredit',
  'alreadyRedeemed',
  'unsupported',
  'error',
]);
export type ConsumeAccountUsageResetCreditOutcome = z.infer<
  typeof consumeAccountUsageResetCreditOutcomeSchema
>;

export const consumeAccountUsageResetCreditResultSchema = z.object({
  outcome: consumeAccountUsageResetCreditOutcomeSchema,
  message: z.string(),
});
export type ConsumeAccountUsageResetCreditResult = z.infer<
  typeof consumeAccountUsageResetCreditResultSchema
>;

export const accountUsageSchema = z.object({
  providerId: z.string(),
  status: z.enum(['available', 'unavailable', 'auth-required', 'error']),
  checkedAt: z.string(),
  source: z.string(),
  message: z.string().optional(),
  account: z.string().optional(),
  /** Abonelik planı (ör. `max`, `pro`); sağlayıcı bildirmiyorsa yoktur. */
  plan: z.string().optional(),
  windows: z.array(
    z.object({
      label: z.string(),
      remainingPercent: z.number().min(0).max(100),
      resetsAt: z.string().optional(),
    })
  ),
  balances: z.array(z.object({ label: z.string(), value: z.number(), unit: z.string() })),
  /** Sağlayıcının verdiği kullanılabilir limit sıfırlama hakları (varsa). */
  resetCredits: accountUsageResetCreditsSchema.optional(),
});
export type AccountUsage = z.infer<typeof accountUsageSchema>;
