import { z } from 'zod';

/** Provider output kept with its message/tool so replay preserves the preview. */
export const transcriptArtifactSchema = z.object({
  uri: z.string(),
  name: z.string(),
  mimeType: z.string().optional(),
});

export type TranscriptArtifact = z.infer<typeof transcriptArtifactSchema>;
