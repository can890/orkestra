import { defineContract, fallible, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

export const textGenerationDomain = 'textGeneration' as const;

export const textGenerationProviderSchema = z.enum(['openai-compatible', 'anthropic']);

export const textGenerationErrorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('disabled'), message: z.string() }),
  z.object({ type: z.literal('missing_api_key'), message: z.string() }),
  z.object({ type: z.literal('invalid_input'), message: z.string() }),
  z.object({ type: z.literal('network'), message: z.string() }),
  z.object({ type: z.literal('http'), status: z.number().int(), message: z.string() }),
  z.object({ type: z.literal('storage_unavailable'), message: z.string() }),
]);
export type TextGenerationError = z.infer<typeof textGenerationErrorSchema>;

export const textGenerationStatusSchema = z.object({
  hasApiKey: z.boolean(),
  secureStorageAvailable: z.boolean(),
  enabled: z.boolean(),
  provider: textGenerationProviderSchema,
  baseUrl: z.string(),
  model: z.string(),
});
export type TextGenerationStatus = z.infer<typeof textGenerationStatusSchema>;

export const textGenerationModelSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type TextGenerationModelSummary = z.infer<typeof textGenerationModelSummarySchema>;

export const promptSuggestionCommandSchema = z.object({
  command: z.string().max(400),
  failed: z.boolean().optional(),
});

export const promptSuggestionTurnActivitySchema = z.object({
  outcome: z.enum(['done', 'cancelled', 'error', 'interrupted']).optional(),
  editedFiles: z.array(z.string().max(300)).max(30).optional(),
  readFilesCount: z.number().int().nonnegative().optional(),
  executedCommands: z.array(promptSuggestionCommandSchema).max(20).optional(),
  createdPlan: z.boolean().optional(),
  failedToolsCount: z.number().int().nonnegative().optional(),
});
export type PromptSuggestionTurnActivity = z.infer<typeof promptSuggestionTurnActivitySchema>;

export const textGenerationContract = defineContract({
  getStatus: procedure({ input: z.void(), output: textGenerationStatusSchema }),
  setApiKey: fallible({
    input: z.object({ apiKey: z.string().min(1).max(512) }),
    error: textGenerationErrorSchema,
  }),
  clearApiKey: fallible({ input: z.void(), error: textGenerationErrorSchema }),
  testConnection: fallible({
    input: z.void(),
    data: z.object({
      ok: z.literal(true),
      latencyMs: z.number(),
      modelCount: z.number().optional(),
    }),
    error: textGenerationErrorSchema,
  }),
  listModels: fallible({
    input: z.void(),
    data: z.array(textGenerationModelSummarySchema),
    error: textGenerationErrorSchema,
  }),
  generateText: fallible({
    input: z.object({
      systemPrompt: z.string().max(4000).optional(),
      prompt: z.string().min(1).max(24000),
      maxTokens: z.number().int().min(16).max(4096).optional(),
      temperature: z.number().min(0).max(2).optional(),
    }),
    data: z.object({ text: z.string(), model: z.string() }),
    error: textGenerationErrorSchema,
  }),
  generatePromptSuggestions: procedure({
    input: z.object({
      lastUserText: z.string().max(2000).optional(),
      lastAssistantText: z.string().max(8000),
      projectName: z.string().max(200).optional(),
      taskName: z.string().max(200).optional(),
      activity: promptSuggestionTurnActivitySchema.optional(),
    }),
    output: z.object({
      source: z.enum(['llm', 'heuristic']),
      suggestions: z.array(z.string()),
    }),
  }),
});

export type TextGenerationContract = typeof textGenerationContract;
