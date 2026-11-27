import { z } from 'zod';

export const handoffModeSchema = z.enum(['fork', 'handoff', 'inline-handoff', 'context-handoff']);

export const handoffChainSegmentSchema = z.object({
  conversationId: z.string().min(1),
  fromProviderId: z.string().min(1),
  fromModelLabel: z.string(),
  toProviderId: z.string().min(1),
  toModelLabel: z.string(),
  createdAt: z.number(),
});

export const handoffRecordSchema = z.object({
  version: z.literal(1),
  mode: handoffModeSchema,
  sourceConversationId: z.string(),
  sourceTitle: z.string(),
  sourceItemId: z.string().optional(),
  context: z.string(),
  contextDelivered: z.boolean().optional(),
  createdAt: z.number(),
  chain: z.array(handoffChainSegmentSchema).optional(),
  targetEffort: z.string().optional(),
  /** Bağlam devri: taşınan kayıt ajanın devir notu mu, otomatik özet mi (eski sürümler yok sayar). */
  contextSource: z.enum(['agent-brief', 'heuristic']).optional(),
  /** Bağlam devri: kaynak konuşmanın tam dökümünün ana makinedeki dosya yolu. */
  transcriptPath: z.string().optional(),
  /** Sol panelde yeni görev olarak açılan devirlerde hedef görevin kimliği. */
  targetTaskId: z.string().optional(),
});

export const handoffBulkImportInputSchema = z.object({
  records: z.array(z.tuple([z.string().min(1), handoffRecordSchema])),
  superseded: z.array(z.tuple([z.string().min(1), z.string().min(1)])),
});

export const handoffListAllOutputSchema = z.object({
  records: z.array(z.tuple([z.string().min(1), handoffRecordSchema])),
  superseded: z.array(z.tuple([z.string().min(1), z.string().min(1)])),
});

export type HandoffMode = z.infer<typeof handoffModeSchema>;
export type HandoffChainSegment = z.infer<typeof handoffChainSegmentSchema>;
export type HandoffRecord = z.infer<typeof handoffRecordSchema>;
export type HandoffBulkImportInput = z.infer<typeof handoffBulkImportInputSchema>;
export type HandoffListAllOutput = z.infer<typeof handoffListAllOutputSchema>;
