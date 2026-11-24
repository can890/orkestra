import { hostRefSchema } from '@orkestra/core/primitives/host/api';
import {
  mcpAppCspSchema,
  mcpAppPermissionsSchema,
  transcriptMcpCallResultSchema,
} from '@orkestra/core/runtimes/acp/api/client';
import { defineContract, fallible } from '@orkestra/wire/rpc';
import { z } from 'zod';

export const mcpAppsDomain = 'mcpApps' as const;

const nameSchema = z.string().min(1).max(256);

/** Bir MCP uygulamasının ait olduğu araç çağrısı: konuşma + sağlayıcının araç çağrısı kimliği. */
const callRefSchema = z.object({
  conversationId: z.string().min(1).max(256),
  toolCallId: z.string().min(1).max(512),
});

export const mcpAppsErrorSchema = z.object({
  type: z.enum(['disabled', 'not-an-app', 'unreachable', 'tool-not-callable', 'request-failed']),
  message: z.string(),
});

export type McpAppsError = z.infer<typeof mcpAppsErrorSchema>;

/** Arayüze verilen uygulama: ham HTML (CSP ve önyükleme betikleri sohbet arayüzünde eklenir). */
export const mcpAppViewSchema = z.object({
  server: z.string(),
  tool: z.string(),
  resourceUri: z.string(),
  html: z.string(),
  csp: mcpAppCspSchema.optional(),
  permissions: mcpAppPermissionsSchema.optional(),
  prefersBorder: z.boolean().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  result: transcriptMcpCallResultSchema.optional(),
  toolDefinition: z.unknown().optional(),
  /** Sunucu artık bulunamıyorsa false: uygulama anlık görüntüden salt okunur gösterilir. */
  live: z.boolean(),
  hostVersion: z.string(),
});

export type McpAppViewDto = z.infer<typeof mcpAppViewSchema>;

export const mcpAppUnavailableReasonSchema = z.enum([
  'disabled',
  'remote-host',
  'unknown-server',
  'unreachable',
  'no-app',
  'too-large',
]);

export type McpAppUnavailableReason = z.infer<typeof mcpAppUnavailableReasonSchema>;

export const mcpAppResolveResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), app: mcpAppViewSchema }),
  z.object({ status: z.literal('none'), reason: mcpAppUnavailableReasonSchema }),
]);

export type McpAppResolveResult = z.infer<typeof mcpAppResolveResultSchema>;

export const mcpAppResolveInputSchema = callRefSchema.extend({
  providerId: nameSchema,
  host: hostRefSchema,
  /** Sağlayıcının bildirdiği sunucu adı (Claude Code'da dönüştürülmüş olabilir). */
  server: nameSchema,
  tool: nameSchema,
  input: z.record(z.string(), z.unknown()).optional(),
  result: transcriptMcpCallResultSchema.optional(),
});

export type McpAppResolveInput = z.infer<typeof mcpAppResolveInputSchema>;

export const mcpAppToolInfoSchema = z.object({
  callable: z.boolean(),
  readOnly: z.boolean(),
  title: z.string().optional(),
});

/**
 * MCP Apps ana makine sözleşmesi. Uygulamanın HTML'i bu sözleşmeye asla erişemez: sohbet arayüzü
 * uygulamanın isteklerini aracılar, gerektiğinde kullanıcıya sorar ve ancak sonra buraya gelir.
 * Uygulama yalnızca kendi araç çağrısının sunucusuna ulaşabilir; ana süreç sunucuyu kaydedilmiş
 * anlık görüntüden bulur, renderer'ın verdiği sunucu adına güvenmez.
 */
export const mcpAppsContract = defineContract({
  resolve: fallible({
    input: mcpAppResolveInputSchema,
    data: mcpAppResolveResultSchema,
    error: mcpAppsErrorSchema,
  }),
  toolInfo: fallible({
    input: callRefSchema.extend({ name: nameSchema }),
    data: mcpAppToolInfoSchema,
    error: mcpAppsErrorSchema,
  }),
  callTool: fallible({
    input: callRefSchema.extend({
      name: nameSchema,
      arguments: z.record(z.string(), z.unknown()),
    }),
    data: transcriptMcpCallResultSchema,
    error: mcpAppsErrorSchema,
  }),
  readResource: fallible({
    input: callRefSchema.extend({ uri: z.string().min(1).max(4096) }),
    data: z.object({ contents: z.array(z.unknown()) }),
    error: mcpAppsErrorSchema,
  }),
});

export type McpAppsContract = typeof mcpAppsContract;
