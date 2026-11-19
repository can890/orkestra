import { defineContract, fallible, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

export const artifactSharesDomain = 'artifactShares' as const;

/** Paylaşım başına toplam içerik sınırı. */
export const ARTIFACT_SHARE_MAX_BYTES = 20 * 1024 * 1024;
/** Aynı anda etkin olabilecek paylaşım sayısı. */
export const ARTIFACT_SHARE_MAX_ACTIVE = 10;

export type ArtifactShareErrorCode =
  | 'too-large'
  | 'too-many'
  | 'invalid-file'
  | 'empty'
  | 'no-network'
  | 'listen-failed';

export type ArtifactShareError = { code: ArtifactShareErrorCode; message: string };

export type ArtifactShareInfo = {
  id: string;
  name: string;
  createdAt: number;
  sizeBytes: number;
  /** Aynı ağdaki cihazların açabileceği adresler (şifresiz http). */
  urls: string[];
};

const fileSchema = z.object({
  /** Paylaşımın içindeki göreli ad (`index.html`, `img/a.png`); disk yolu değildir. */
  path: z.string(),
  /** Base64 içerik. */
  base64: z.string(),
});

export const artifactSharesContract = defineContract({
  create: fallible({
    input: z.object({
      name: z.string(),
      /** `files` içindeki ana dosyanın adı. */
      entry: z.string(),
      files: z.array(fileSchema).min(1),
    }),
    data: z.custom<ArtifactShareInfo>(),
    error: z.custom<ArtifactShareError>(),
  }),
  list: procedure({ input: z.void(), output: z.array(z.custom<ArtifactShareInfo>()) }),
  revoke: procedure({ input: z.object({ id: z.string() }), output: z.void() }),
});
