import { z } from 'zod';

export const accountUsageSchema = z.object({
  providerId: z.string(),
  status: z.enum(['available', 'unavailable', 'auth-required', 'error']),
  checkedAt: z.string(),
  source: z.string(),
  message: z.string().optional(),
  account: z.string().optional(),
  windows: z.array(z.object({
    label: z.string(), remainingPercent: z.number().min(0).max(100),
    resetsAt: z.string().optional(),
  })),
  balances: z.array(z.object({ label: z.string(), value: z.number(), unit: z.string() })),
});
export type AccountUsage = z.infer<typeof accountUsageSchema>;
