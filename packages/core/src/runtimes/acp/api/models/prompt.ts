import { z } from 'zod';
import { promptAttachmentSchema } from './attachments';
export type { PromptAttachment } from './attachments';

export const promptInputSchema = z.object({
  text: z.string(),
  hiddenContext: z.string().optional(),
  attachments: z.array(promptAttachmentSchema).optional(),
});
export type PromptInput = z.infer<typeof promptInputSchema>;

export const queuedPromptSchema = promptInputSchema.extend({
  /** Runtime-generated id used for queue removal and stable UI keys. */
  id: z.string(),
  /** Epoch ms when this prompt entered the runtime queue/model. */
  createdAt: z.number(),
  /** Epoch ms when queued prompt content or attachments were last edited. */
  updatedAt: z.number(),
  /**
   * Why a message sent during a running turn waits in the queue instead of joining the turn (see
   * `QUEUE_REASONS`). Optional and open-ended so older and newer hosts and clients interoperate;
   * an unknown value is shown like no reason.
   */
  queueReason: z.string().optional(),
});
export type QueuedPrompt = z.infer<typeof queuedPromptSchema>;

/** Known `QueuedPrompt.queueReason` values. */
export const QUEUE_REASONS = {
  /** The agent kind takes no input during a turn (no steering support). */
  noSteering: 'no-steering',
  /** A permission prompt of the running turn is open. */
  awaitingPermission: 'awaiting-permission',
  /** The session is still connecting or replaying. */
  connecting: 'connecting',
  /** The agent waits on a background task and cannot take input until it ends. */
  backgroundTask: 'background-task',
  /** Antigravity Orchestrator sessions run on stream-json, which reads input between turns. */
  antigravityOrchestrator: 'antigravity-orchestrator',
  /** Antigravity runs on stream-json (agy acp unavailable or not chosen). */
  antigravityStreamJson: 'antigravity-stream-json',
} as const;
