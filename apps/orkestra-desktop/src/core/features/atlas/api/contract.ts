import type { Result } from '@orkestra/shared';
import { defineContract, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';
import type { AtlasCardRecord, AtlasError, AtlasStatus } from './atlas-model';

export const atlasDomain = 'atlas' as const;

const conversationInput = z.object({ conversationId: z.string().min(1).max(256) });

/**
 * Atlas sözleşmesi: durum (CLI algılama, son hata, son kartlar), insan için arama/geçmiş ve
 * sohbet başına kart yazma / kart yazmama işareti. Ajan araçları bu sözleşmeyi kullanmaz.
 */
export const atlasContract = defineContract({
  getStatus: procedure({
    input: z.object({ refresh: z.boolean().optional() }),
    output: z.custom<AtlasStatus>(),
  }),
  search: procedure({
    input: z.object({ query: z.string().max(400), limit: z.number().int().optional() }),
    output: z.custom<Result<string, AtlasError>>(),
  }),
  projectHistory: procedure({
    input: z.object({ projectId: z.string().min(1) }),
    output: z.custom<Result<string, AtlasError>>(),
  }),
  /** "Bu sohbet için Atlas kartı yaz" komutu; ayar kapalı olsa da çalışır, iki kez yazmaz. */
  writeCard: procedure({
    input: conversationInput,
    output: z.custom<Result<AtlasCardRecord, AtlasError>>(),
  }),
  conversationState: procedure({
    input: conversationInput,
    output: z.object({ written: z.boolean(), skipped: z.boolean() }),
  }),
  setSkipped: procedure({
    input: conversationInput.extend({ skipped: z.boolean() }),
    output: z.void(),
  }),
});
