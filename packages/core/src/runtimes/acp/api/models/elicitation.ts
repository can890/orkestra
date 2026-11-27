import { z } from 'zod';

/**
 * Elicitation (etkileşimli kullanıcı sorusu / seçenek / kutucuk / form) şemaları.
 * ACP `elicitation/create` standardını (Claude AskUserQuestion, Antigravity ask_question,
 * Codex request_user_input ve MCP elicitation) tek modelde taşır.
 */
export const acpElicitationActionSchema = z.enum(['accept', 'decline', 'cancel']);
export type AcpElicitationAction = z.infer<typeof acpElicitationActionSchema>;

export const acpElicitationContentValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);
export type AcpElicitationContentValue = z.infer<typeof acpElicitationContentValueSchema>;

export const acpElicitationContentSchema = z.record(z.string(), acpElicitationContentValueSchema);
export type AcpElicitationContent = z.infer<typeof acpElicitationContentSchema>;

export const acpElicitationRequestSchema = z.object({
  /** SessionCell tarafından bu istek için üretilen kararlı kimlik. */
  requestId: z.string(),
  /** Sağlayıcının veya MCP sunucusunun elicitation kimliği (varsa). */
  elicitationId: z.string().optional(),
  /** Soruyu tetikleyen araç çağrısı kimliği (varsa). */
  toolCallId: z.string().optional(),
  /** 'form' (yapısal seçenek/kutucuk/alan) veya 'url' (tarayıcı yönlendirmesi). */
  mode: z.enum(['form', 'url']),
  /** Kullanıcıya gösterilen ana soru / açıklama metni. */
  message: z.string(),
  /** URL tabanlı elicitation adresi (mode === 'url' için). */
  url: z.string().optional(),
  /** JSON Schema nesnesi (mode === 'form' için `properties`, `required` vb.). */
  requestedSchema: z.record(z.string(), z.unknown()).optional(),
});
export type AcpElicitationRequest = z.infer<typeof acpElicitationRequestSchema>;

export const acpElicitationDecisionSchema = z.object({
  requestId: z.string(),
  action: acpElicitationActionSchema,
  content: acpElicitationContentSchema.optional(),
});
export type AcpElicitationDecision = z.infer<typeof acpElicitationDecisionSchema>;
