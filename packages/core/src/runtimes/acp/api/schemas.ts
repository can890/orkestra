import { z } from 'zod';
import { permissionDecisionSchema } from '#runtimes/acp/api/models/permissions';
import { promptInputSchema, queuedPromptSchema } from '#runtimes/acp/api/models/prompt';
import { transcriptTurnSchema } from '#runtimes/acp/api/models/turns';
import { transcriptPositionSchema, transcriptCoverageSchema } from './models/transcript';

/** Conversation-scoped stdio MCP server appended to the provider's configured servers. */
export const acpSessionMcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
});
export type AcpSessionMcpServer = z.infer<typeof acpSessionMcpServerSchema>;

export const acpStartInputSchema = z.object({
  conversationId: z.string(),
  providerId: z.string(),
  cwd: z.string(),
  sessionId: z.string().nullable(),
  model: z.string().nullable(),
  modeId: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  collaborationMode: z.string().nullable().optional(),
  initialQueue: z.array(promptInputSchema).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Extra stdio MCP servers for this conversation only (e.g. the Orkestra conductor tools). */
  mcpServers: z.array(acpSessionMcpServerSchema).optional(),
});
export type AcpStartInputWire = z.infer<typeof acpStartInputSchema>;

export const sendPromptResponseSchema = z.object({ queued: z.boolean() });

export const terminateCommandSchema = z.object({ conversationId: z.string() });
export const promptPlacementSchema = z.enum(['auto', 'queue']);
export type PromptPlacement = z.infer<typeof promptPlacementSchema>;
export const sendPromptCommandSchema = z.object({
  conversationId: z.string(),
  /** Correlates session acceptance with the queue and transcript. */
  promptId: z.string().uuid(),
  prompt: promptInputSchema,
  /** 'queue' always queues; 'auto' (default) delivers if idle and queues while a turn is active. */
  placement: promptPlacementSchema.optional(),
});
export const editQueuedPromptCommandSchema = z.object({
  conversationId: z.string(),
  id: z.string(),
  input: promptInputSchema,
});
export const deleteQueuedPromptCommandSchema = z.object({
  conversationId: z.string(),
  id: z.string(),
});
export const changeQueuePromptOrderCommandSchema = z.object({
  conversationId: z.string(),
  ids: z.array(z.string()),
});
export const cancelTurnCommandSchema = z.object({ conversationId: z.string() });
export const setOptionCommandSchema = z.object({
  conversationId: z.string(),
  key: z.enum(['model', 'mode', 'effort', 'collaborationMode']),
  value: z.string(),
});
export const resolvePermissionCommandSchema = permissionDecisionSchema.extend({
  conversationId: z.string(),
});
export const exportAcpTranscriptCommandSchema = z.object({ conversationId: z.string() });
export const exportRawAcpLogCommandSchema = exportAcpTranscriptCommandSchema;

export const historyPageInputSchema = z.object({
  conversationId: z.string(),
  before: z.number().int().optional(),
  limit: z.number().int(),
});

export const historyPageSchema = z.object({
  turns: z.array(transcriptTurnSchema),
  nextCursor: z.number().int().nullable(),
  /** Absent only when unavailable or when talking to an older runtime. */
  position: transcriptPositionSchema.optional(),
  coverage: transcriptCoverageSchema.optional(),
  /** History is activation-local and currently unavailable while the session is suspended. */
  unavailable: z.literal(true).optional(),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;

/**
 * Stored selections that activation applied under the provider's own option id (for example a
 * catalog model id resolved to a Claude alias such as `sonnet`). Hosts persist these values so
 * later activations match the provider catalog exactly.
 */
export const resolvedConfigurationSchema = z.object({
  model: z.string().optional(),
  effort: z.string().optional(),
  collaborationMode: z.string().optional(),
});
export type ResolvedConfiguration = z.infer<typeof resolvedConfigurationSchema>;

export const loadHistoryResultSchema = historyPageSchema.extend({
  clearedConfiguration: z
    .array(z.enum(['model', 'modeId', 'effort', 'collaborationMode']))
    .optional(),
  resolvedConfiguration: resolvedConfigurationSchema.optional(),
});
export type LoadHistoryResult = z.infer<typeof loadHistoryResultSchema>;

export { queuedPromptSchema };
