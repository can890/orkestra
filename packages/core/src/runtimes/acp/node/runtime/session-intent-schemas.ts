import { z } from 'zod';
import {
  acpStartInputSchema,
  sessionConfigStateSchema,
  sessionMcpServerSchema,
  sessionUsageSchema,
} from '#runtimes/acp/api';

const retainedConfiguredSchema = z.object({
  model: z.string().nullable(),
  modeId: z.string().nullable(),
  effort: z.string().nullable(),
  collaborationMode: z.string().nullable().optional(),
});

const retainedPresentationSchema = z.object({
  configured: retainedConfiguredSchema,
  lastKnownCapabilities: sessionConfigStateSchema,
  lastKnownMcpServers: z.array(sessionMcpServerSchema),
  lastKnownUsage: sessionUsageSchema.nullable(),
  observedAt: z.number().int().nullable(),
});

export const persistedIntentV1Schema = z.object({
  version: z.literal('1'),
  conversationId: z.string(),
  providerId: z.string(),
  cwd: z.string(),
  sessionId: z.string().nullable(),
  /**
   * Set only while `sessionId` was minted by `newSession` in this runtime and no prompt has been
   * dispatched to it, so the provider holds no transcript for it. Absent means unknown.
   */
  unpromptedSessionId: z.string().nullable().optional(),
  configured: retainedConfiguredSchema,
  presentation: retainedPresentationSchema,
});

export const legacyRetainedIntentSchema = acpStartInputSchema.extend({
  configOverrides: z
    .object({
      model: z.string().optional(),
      effort: z.string().optional(),
      collaborationMode: z.string().optional(),
    })
    .optional(),
});
