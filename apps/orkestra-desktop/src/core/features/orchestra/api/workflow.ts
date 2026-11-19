import { defineVersionedSchema } from '@orkestra/core/primitives/versioned-schema/api';
import { procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

/** İş akışı sınırları; doğrulama hem arayüzde hem ana süreçte aynı değerlerle yapılır. */
export const WORKFLOW_MAX_STEPS = 20;
export const WORKFLOW_MAX_PROMPT_CHARS = 20_000;
export const WORKFLOW_MAX_INPUT_CHARS = 20_000;
/** Aynı worktree'de birden fazla ajan birbirinin dosyasını ezebilir; üst sınır bu yüzden düşük. */
export const WORKFLOW_MAX_CONCURRENCY = 3;
/** Varsayılan 1: adımlar sırayla çalışır; paralellik kullanıcının bilinçli tercihidir. */
export const WORKFLOW_DEFAULT_CONCURRENCY = 1;
/** Bir adımın raporu, sonraki adımın istemine en fazla bu kadar karakterle eklenir. */
export const WORKFLOW_REPORT_BUDGET_CHARS = 8_000;
/** Çalıştırma kaydında adım başına saklanan en fazla rapor uzunluğu. */
export const WORKFLOW_STORED_REPORT_CHARS = 20_000;
export const WORKFLOW_DEFAULT_STEP_TIMEOUT_MS = 30 * 60_000;

/** Adım ve iş akışı kimlikleri şablon sözdizimiyle (`{{steps.<id>.report}}`) uyumlu tutulur. */
export const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const WORKFLOW_STEP_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export const workflowStepSchema = z.object({
  id: z.string().regex(WORKFLOW_STEP_ID_PATTERN, 'Adım kimliği harf, rakam, "_" ve "-" içerebilir'),
  /** Sağlayıcı (ajan) kimliği. */
  agent: z.string().min(1).max(64),
  model: z.string().min(1).max(200).nullable().optional(),
  prompt: z.string().min(1, 'İstem boş olamaz').max(WORKFLOW_MAX_PROMPT_CHARS),
  dependsOn: z.array(z.string()).max(WORKFLOW_MAX_STEPS),
});
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowDefinitionSchema = z.object({
  id: z.string().regex(WORKFLOW_ID_PATTERN),
  name: z.string().trim().min(1, 'Ad boş olamaz').max(120),
  description: z.string().max(2000).optional(),
  steps: z
    .array(workflowStepSchema)
    .min(1, 'En az bir adım gerekli')
    .max(WORKFLOW_MAX_STEPS, `En fazla ${WORKFLOW_MAX_STEPS} adım olabilir`),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/** `userData/orchestra/workflows.json` */
const workflowStoreV1 = z.object({
  version: z.literal('1'),
  workflows: z.array(workflowDefinitionSchema),
});
export const workflowStoreSchema = defineVersionedSchema().initial('1', workflowStoreV1).build();
export type WorkflowStore = typeof workflowStoreSchema.Type;

export const workflowStepStatusSchema = z.enum([
  'pending',
  'running',
  'awaiting-permission',
  'completed',
  'failed',
  'skipped',
  'cancelled',
]);
export type WorkflowStepStatus = z.infer<typeof workflowStepStatusSchema>;

export const workflowRunStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

export const workflowRunStepSchema = z.object({
  id: z.string(),
  agent: z.string(),
  model: z.string().nullable(),
  dependsOn: z.array(z.string()),
  status: workflowStepStatusSchema,
  /** Adımın işçi sohbeti; başlatılmadıysa null. */
  workerId: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  report: z.string().nullable(),
  error: z.string().nullable(),
});
export type WorkflowRunStep = z.infer<typeof workflowRunStepSchema>;

export const workflowRunSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  input: z.string(),
  autoApprove: z.boolean(),
  maxConcurrency: z.number().int().min(1).max(WORKFLOW_MAX_CONCURRENCY),
  status: workflowRunStatusSchema,
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
  steps: z.array(workflowRunStepSchema),
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

/** `userData/orchestra/workflow-runs.json` */
const workflowRunStoreV1 = z.object({
  version: z.literal('1'),
  runs: z.array(workflowRunSchema),
});
export const workflowRunStoreSchema = defineVersionedSchema()
  .initial('1', workflowRunStoreV1)
  .build();
export type WorkflowRunStore = typeof workflowRunStoreSchema.Type;

const workflowErrorsSchema = z.object({ ok: z.literal(false), errors: z.array(z.string()) });

/** Konuşmalar sözleşmesine `workflows` alt sözleşmesi olarak eklenir. */
export const workflowContractDefinitions = {
  list: procedure({ input: z.void(), output: z.array(workflowDefinitionSchema) }),
  save: procedure({
    input: z.object({ workflow: workflowDefinitionSchema }),
    output: z.union([
      z.object({ ok: z.literal(true), workflow: workflowDefinitionSchema }),
      workflowErrorsSchema,
    ]),
  }),
  delete: procedure({ input: z.object({ id: z.string() }), output: z.boolean() }),
  startRun: procedure({
    input: z.object({
      projectId: z.string(),
      taskId: z.string(),
      workflowId: z.string(),
      input: z.string().max(WORKFLOW_MAX_INPUT_CHARS),
      /** Varsayılan kapalı: kapalıyken izinler işçi sohbetinde kullanıcıya kalır. */
      autoApprove: z.boolean(),
      maxConcurrency: z.number().int().min(1).max(WORKFLOW_MAX_CONCURRENCY),
    }),
    output: z.union([
      z.object({ ok: z.literal(true), run: workflowRunSchema }),
      workflowErrorsSchema,
    ]),
  }),
  getRun: procedure({
    input: z.object({ runId: z.string() }),
    output: workflowRunSchema.nullable(),
  }),
  listRuns: procedure({
    input: z.object({ taskId: z.string().optional() }),
    output: z.array(workflowRunSchema),
  }),
  cancelRun: procedure({ input: z.object({ runId: z.string() }), output: z.boolean() }),
};
