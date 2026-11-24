import { procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

/**
 * Kod olarak yazılan iş akışlarının (`~/.orkestra/workflows/*.ts`) sözleşmesi. Adım tabanlı
 * iş akışlarının (`conversations.workflows`) yanında, `conversations.codeWorkflows` alt sözleşmesi
 * olarak eklenir; ajan adımları konuşmalar denetleyicisindeki ana süreç işlevlerini kullanır.
 */

export const codeWorkflowRunStatusSchema = z.enum([
  'running',
  'waiting',
  'paused',
  'completed',
  'stopped',
  'skipped',
  'cancelled',
]);
export type CodeWorkflowRunStatus = z.infer<typeof codeWorkflowRunStatusSchema>;

export const ACTIVE_RUN_STATUSES: readonly CodeWorkflowRunStatus[] = [
  'running',
  'waiting',
  'paused',
];

export const codeWorkflowEntryKindSchema = z.enum(['step', 'agent', 'ask', 'sleep']);
export type CodeWorkflowEntryKind = z.infer<typeof codeWorkflowEntryKindSchema>;

export const codeWorkflowEntryStatusSchema = z.enum([
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]);
export type CodeWorkflowEntryStatus = z.infer<typeof codeWorkflowEntryStatusSchema>;

export const codeWorkflowQuestionSchema = z.object({
  title: z.string(),
  choices: z.array(z.string()),
  data: z.unknown().optional(),
  timeoutAt: z.number().nullable(),
});
export type CodeWorkflowQuestion = z.infer<typeof codeWorkflowQuestionSchema>;

export const codeWorkflowAgentInfoSchema = z.object({
  provider: z.string().nullable(),
  model: z.string().nullable(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  /** Son denemenin sohbeti; başlatılmadıysa null. */
  conversationId: z.string().nullable(),
  /** Tüm denemelerin sohbetleri (eskiden yeniye). */
  conversations: z.array(z.string()),
});
export type CodeWorkflowAgentInfo = z.infer<typeof codeWorkflowAgentInfoSchema>;

export const codeWorkflowEntrySchema = z.object({
  name: z.string(),
  kind: codeWorkflowEntryKindSchema,
  status: codeWorkflowEntryStatusSchema,
  attempts: z.number().int(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  /** Başarıyla biten adımın JSON değeri; yeniden oynatmada aynen döner. */
  value: z.unknown().optional(),
  error: z.string().nullable(),
  agent: codeWorkflowAgentInfoSchema.optional(),
  question: codeWorkflowQuestionSchema.optional(),
  wakeAt: z.number().optional(),
});
export type CodeWorkflowEntry = z.infer<typeof codeWorkflowEntrySchema>;

export const codeWorkflowTriggerKindSchema = z.enum([
  'manual',
  'schedule',
  'webhook',
  'issue',
  'pull-request',
]);
export type CodeWorkflowTriggerKind = z.infer<typeof codeWorkflowTriggerKindSchema>;

export const codeWorkflowRunSchema = z.object({
  id: z.string(),
  workflow: z.string(),
  version: z.number().int(),
  key: z.string(),
  title: z.string().nullable(),
  status: codeWorkflowRunStatusSchema,
  payload: z.unknown(),
  trigger: z.object({ kind: codeWorkflowTriggerKindSchema, detail: z.string().nullable() }),
  createdAt: z.number(),
  updatedAt: z.number(),
  endedAt: z.number().nullable(),
  result: z.unknown().optional(),
  /** stop/skip/cancel gerekçesi ya da duraklatma nedeni. */
  reason: z.string().nullable(),
  /** Duraklatmaya yol açan hata. */
  error: z.string().nullable(),
  /** Neden duraklatıldığı: `agent` ve `user` kendiliğinden devam etmez. */
  pauseKind: z.enum(['step', 'agent', 'body', 'user', 'retired']).nullable(),
  autoResumeCount: z.number().int(),
  nextResumeAt: z.number().nullable(),
  entries: z.array(codeWorkflowEntrySchema),
});
export type CodeWorkflowRun = z.infer<typeof codeWorkflowRunSchema>;

export const codeWorkflowTriggerSummarySchema = z.object({
  kind: z.enum(['schedule', 'webhook', 'issues', 'pull-requests']),
  label: z.string(),
  nextAt: z.number().nullable(),
});

export const codeWorkflowDefinitionSummarySchema = z.object({
  name: z.string(),
  version: z.number().int(),
  file: z.string(),
  description: z.string().nullable(),
  triggers: z.array(codeWorkflowTriggerSummarySchema),
  /** Bu adın en yüksek sürümü mü (elle ve tetikleyiciyle başlatılan sürüm). */
  latest: z.boolean(),
});
export type CodeWorkflowDefinitionSummary = z.infer<typeof codeWorkflowDefinitionSummarySchema>;

export const codeWorkflowProblemSchema = z.object({
  file: z.string(),
  message: z.string(),
  line: z.number().int().nullable(),
});
export type CodeWorkflowProblem = z.infer<typeof codeWorkflowProblemSchema>;

export const codeWorkflowStatusSchema = z.object({
  enabled: z.boolean(),
  folder: z.string(),
  definitions: z.array(codeWorkflowDefinitionSummarySchema),
  problems: z.array(codeWorkflowProblemSchema),
});
export type CodeWorkflowStatus = z.infer<typeof codeWorkflowStatusSchema>;

export const codeWorkflowHookSchema = z.object({
  workflow: z.string(),
  hook: z.string(),
  /** Gizli belirteci içerir; yalnızca göndericiyle paylaşılmalı. */
  url: z.string(),
});
export type CodeWorkflowHook = z.infer<typeof codeWorkflowHookSchema>;

const actionResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type CodeWorkflowActionResult = z.infer<typeof actionResultSchema>;

export const codeWorkflowContractDefinitions = {
  status: procedure({ input: z.void(), output: codeWorkflowStatusSchema }),
  listRuns: procedure({
    input: z.object({ limit: z.number().int().min(1).max(500).optional() }),
    output: z.array(codeWorkflowRunSchema),
  }),
  getRun: procedure({
    input: z.object({ runId: z.string() }),
    output: codeWorkflowRunSchema.nullable(),
  }),
  start: procedure({
    input: z.object({
      workflow: z.string().min(1),
      /** JSON metni; boşsa `null` yük. */
      input: z.string().max(200_000),
      key: z.string().max(500).optional(),
    }),
    output: z.union([
      z.object({ ok: z.literal(true), runId: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  }),
  answer: procedure({
    input: z.object({
      runId: z.string(),
      name: z.string(),
      choice: z.string(),
      reason: z.string().max(4000).optional(),
    }),
    output: actionResultSchema,
  }),
  pause: procedure({ input: z.object({ runId: z.string() }), output: actionResultSchema }),
  resume: procedure({ input: z.object({ runId: z.string() }), output: actionResultSchema }),
  cancel: procedure({
    input: z.object({ runId: z.string(), reason: z.string().max(1000).optional() }),
    output: actionResultSchema,
  }),
  hooks: procedure({ input: z.void(), output: z.array(codeWorkflowHookSchema) }),
  openFolder: procedure({ input: z.void(), output: actionResultSchema }),
};
