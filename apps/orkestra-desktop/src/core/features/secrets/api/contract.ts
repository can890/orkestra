import { defineContract, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

export const secretsDomain = 'secrets' as const;

export const onePasswordStatusSchema = z.object({
  installed: z.boolean(),
  version: z.string().optional(),
  signedIn: z.boolean(),
  accountEmail: z.string().optional(),
  error: z.string().optional(),
});
export type OnePasswordStatus = z.infer<typeof onePasswordStatusSchema>;

export const secretsContract = defineContract({
  checkOnePasswordCli: procedure({
    input: z.object({ account: z.string().max(200).optional() }).optional(),
    output: onePasswordStatusSchema,
  }),
  resolvePreview: procedure({
    input: z.object({
      reference: z.string().min(5).max(500),
      account: z.string().max(200).optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      maskedPreview: z.string().optional(),
      error: z.string().optional(),
    }),
  }),
});

export type SecretsContract = typeof secretsContract;
