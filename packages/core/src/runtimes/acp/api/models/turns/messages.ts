import { z } from 'zod';
import { transcriptArtifactSchema } from '#primitives/acp-transcript/api/artifacts';
import { attachmentMetadataSchema } from '#services/attachments/api';

export const transcriptMessageSchema = z.object({
  kind: z.literal('message'),
  /** Opaque reducer-owned identity, scoped to the turn, role, and identity origin. */
  id: z.string(),
  /** Stable order within the owning turn, assigned once by the reducer. */
  seq: z.number().int(),
  role: z.enum(['user', 'assistant']),
  /** Correlates an accepted prompt without matching message text. */
  promptId: z.string().optional(),
  text: z.string(),
  artifacts: z.array(transcriptArtifactSchema).optional(),
  /** Attachment metadata only; bytes are served separately by the runtime. */
  attachments: z.array(attachmentMetadataSchema).optional(),
  /**
   * Present on the user question and its answer when this is a side exchange: a short-lived,
   * read-only session answered it while the main agent kept working, so the main agent never saw
   * it. Orkestra-authored; never produced by replaying provider history.
   */
  side: z
    .object({
      /** The user's original message, so the host can forward it to the main agent. */
      question: z.string(),
      status: z.enum(['pending', 'running', 'done', 'error']),
    })
    .optional(),
});
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;
