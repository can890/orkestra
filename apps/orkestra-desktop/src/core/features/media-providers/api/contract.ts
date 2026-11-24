import { defineContract, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';
import type { MediaProviderStatus } from './media-providers-model';

export const mediaProvidersDomain = 'mediaProviders' as const;

export const mediaProvidersContract = defineContract({
  /** CLI algılama + oturum durumu; `refresh` ile yeniden denetlenir. */
  status: procedure({
    input: z.object({ refresh: z.boolean().optional() }),
    output: z.custom<MediaProviderStatus[]>(),
  }),
});
