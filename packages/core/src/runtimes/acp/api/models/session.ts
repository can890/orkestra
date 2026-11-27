import { z } from 'zod';
import { acpElicitationRequestSchema } from './elicitation';
import { acpPermissionRequestSchema } from './permissions';
import { queuedPromptSchema } from './prompt';
import { stopReasonSchema } from './stop-reason';
import { transcriptSnapshotSchema } from './transcript';

/**
 * ACP session lifecycle owned by the SessionMachine.
 *
 * - `starting`: agent process/session setup is in progress.
 * - `replaying`: an existing ACP session is loading historical updates.
 * - `ready`: no foreground work is active; a prompt can start immediately.
 * - `working`: a foreground user prompt turn is running.
 * - `cancelling`: cancellation was requested; waiting for agent settlement.
 * - `closed`: runtime session is no longer usable.
 */
export const sessionLifecycleSchema = z.enum([
  'starting',
  'replaying',
  'ready',
  'working',
  'cancelling',
  'closed',
]);
export type SessionLifecycle = z.infer<typeof sessionLifecycleSchema>;

export const sessionStateSchema = z.object({
  lifecycle: sessionLifecycleSchema,
  /** Present and true when the conversation is retained without a live provider session. */
  suspended: z.literal(true).optional(),
  /** Current control-plane turn id, or null when no prompt/replay turn is active. */
  activeTurnId: z.string().nullable(),
  /** Generation-local revision of all committed-history changes (legacy notification). */
  historyRevision: z.number().int().nonnegative().optional(),
  /** Coherent transcript position and live turn. Absent on older runtimes or before activation. */
  transcript: transcriptSnapshotSchema.optional(),
  pendingPermissions: z.array(acpPermissionRequestSchema),
  /** Bekleyen etkileşimli kullanıcı soruları / form istekleri (`elicitation/create`). */
  pendingElicitations: z.array(acpElicitationRequestSchema).optional(),
  /** Last ACP prompt stop reason observed by the machine; separate from transcript outcomes. */
  lastStopReason: stopReasonSchema.nullable(),
  /** True when the last turn failed without producing an ACP stop reason. */
  lastTurnErrored: z.boolean(),
  /** Prompts accepted while busy; attachments are references, never inline bytes. */
  queuedPrompts: z.array(queuedPromptSchema),
  /** True while agent-originated updates are still arriving outside a user prompt turn. */
  agentTurnActive: z.boolean(),
  /** Count of running background subagents, used for affordances and busy state. */
  backgroundAgentCount: z.number().int(),
  /** Machine-owned UI affordance: true while foreground or background work is active. */
  isGenerating: z.boolean(),
  /** Machine-owned UI affordance: true when a prompt may be accepted or queued. */
  canSubmit: z.boolean(),
  /** Machine-owned UI affordance: true when there is cancellable foreground/agent work. */
  canCancel: z.boolean(),
  /**
   * Present and true when the agent advertised `_meta.steering.supported` at initialize, so a
   * prompt may be injected into a running turn. Absent means "not supported or unknown".
   */
  supportsSteering: z.literal(true).optional(),
  /**
   * Liveness of the running work, present only while a turn or agent-originated activity runs
   * (`working`, `cancelling`, or `agentTurnActive`). Epoch milliseconds on the runtime's clock.
   * `lastActivityAt` is the last provider update for this session; it is republished at most
   * every few seconds, so consumers must treat it as approximate. Absent on older runtimes.
   */
  activity: z
    .object({
      turnStartedAt: z.number(),
      lastActivityAt: z.number(),
      /**
       * Background tasks of the running work the provider reported as still running (a long
       * image or video job); present only when positive. While set, silence is not a stall.
       * Absent on older runtimes.
       */
      backgroundTasks: z.number().int().positive().optional(),
    })
    .optional(),
});
export type SessionState = z.infer<typeof sessionStateSchema>;

export const sessionSummarySchema = z.object({
  conversationId: z.string(),
  providerId: z.string(),
  cwd: z.string().optional(),
  lifecycle: sessionLifecycleSchema,
  /** Present and true when the conversation is retained without a live provider session. */
  suspended: z.literal(true).optional(),
  isGenerating: z.boolean(),
  lastStopReason: stopReasonSchema.nullable(),
  lastTurnErrored: z.boolean(),
  pendingPermissionCount: z.number().int(),
  backgroundAgentCount: z.number().int(),
  queuedPromptCount: z.number().int(),
  title: z.string().nullable(),
  updatedAt: z.number(),
  lastInputAt: z.number().int().optional(),
  lastOutputAt: z.number().int().optional(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
