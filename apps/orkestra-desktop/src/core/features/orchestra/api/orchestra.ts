import { procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

/** Ajan seçicide gösterilen sanal Orkestra girdisinin kimliği. Gerçek bir eklenti değildir. */
export const ORCHESTRA_AGENT_ID = 'orkestra';

/** Şefin yönetebileceği bir işçi ajan; renderer kurulu ve ACP destekli ajanlardan üretir. */
export const orchestraWorkerAgentSchema = z.object({
  providerId: z.string().min(1),
  name: z.string().min(1),
  models: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type OrchestraWorkerAgent = z.infer<typeof orchestraWorkerAgentSchema>;

export const orchestraSettingsSchema = z.object({
  conductorProviderId: z.string().min(1),
  conductorModel: z.string().nullable(),
  workers: z.array(orchestraWorkerAgentSchema).min(1),
  /** Aynı anda çalışabilecek işçi sayısı; 0 sınırsız demektir. */
  maxParallel: z.number().int().min(0).max(1000),
  autoApproveWorkers: z.boolean(),
  /** Kullanıcının yönlendirme tercihleri; yerleşik profillerin önüne geçer. */
  routingNotes: z.string().max(8000),
});
export type OrchestraSettings = z.infer<typeof orchestraSettingsSchema>;

export const orchestraWorkerStatusSchema = z.enum([
  'starting',
  'running',
  'awaiting-permission',
  'done',
  'error',
  'cancelled',
]);
export type OrchestraWorkerStatus = z.infer<typeof orchestraWorkerStatusSchema>;

export const orchestraWorkerSummarySchema = z.object({
  workerId: z.string(),
  providerId: z.string(),
  agentName: z.string(),
  model: z.string().nullable(),
  title: z.string(),
  role: z.string().nullable(),
  createdAt: z.number(),
});
export type OrchestraWorkerSummary = z.infer<typeof orchestraWorkerSummarySchema>;

export const orchestraSessionSchema = z.object({
  conversationId: z.string(),
  settings: orchestraSettingsSchema,
  workers: z.array(orchestraWorkerSummarySchema),
});
export type OrchestraSession = z.infer<typeof orchestraSessionSchema>;

const conversationKey = z.object({ conversationId: z.string() });

/** Konuşmalar sözleşmesine `orchestra` alt sözleşmesi olarak eklenir. */
export const orchestraContractDefinitions = {
  register: procedure({
    input: z.object({
      conversationId: z.string(),
      projectId: z.string(),
      taskId: z.string(),
      settings: orchestraSettingsSchema,
    }),
    output: z.void(),
  }),
  get: procedure({
    input: conversationKey,
    output: orchestraSessionSchema.nullable(),
  }),
  /** Şefin ilk istemine gizli bağlam olarak eklenen çalışma kılavuzu; şef değilse null. */
  conductorContext: procedure({
    input: conversationKey,
    output: z.string().nullable(),
  }),
};
