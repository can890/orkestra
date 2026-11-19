import { defineVersionedSchema } from '@orkestra/core/primitives/versioned-schema/api';
import { z } from 'zod';

/**
 * Orkestra düzeyindeki kancaların (hooks) yapılandırması. Yalnızca kullanıcının Ayarlar →
 * Kancalar sayfasından yazdığı komutlar burada tutulur; host-yerel sürümlü JSON dosyasında
 * saklanır (bkz. `node/hook-config-store.ts`). Depo dosyalarından okunmaz.
 */

export const HOOK_EVENTS = [
  'conversation.prompt-submitted',
  'conversation.turn-ended',
  'conversation.permission-requested',
  'task.created',
  'task.archived',
] as const;

export const hookEventSchema = z.enum(HOOK_EVENTS);
export type HookEventName = z.infer<typeof hookEventSchema>;

export const HOOK_EVENT_LABELS: Record<HookEventName, string> = {
  'conversation.prompt-submitted': 'Prompt gönderildi',
  'conversation.turn-ended': 'Ajan turu bitti',
  'conversation.permission-requested': 'İzin istendi',
  'task.created': 'Görev oluşturuldu',
  'task.archived': 'Görev arşivlendi',
};

export const DEFAULT_HOOK_TIMEOUT_SEC = 30;
export const MAX_HOOK_TIMEOUT_SEC = 300;
export const MAX_HOOKS = 50;
export const MAX_HOOK_COMMAND_LENGTH = 4000;
export const MAX_HOOK_PROJECT_FILTER = 50;

export const hookDefinitionSchema = z.object({
  /** Kararlı, kullanıcı tarafından değiştirilmeyen kimlik. */
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'Kimlik yalnızca harf, rakam, "_" ve "-" içerebilir'),
  name: z.string().max(80),
  event: hookEventSchema,
  /** Kullanıcının yazdığı haliyle çalışır; olay verisi buraya hiçbir zaman gömülmez. */
  command: z
    .string()
    .trim()
    .min(1, 'Komut boş olamaz')
    .max(MAX_HOOK_COMMAND_LENGTH)
    .refine((value) => !value.includes('\0'), 'Komut NUL karakteri içeremez'),
  enabled: z.boolean(),
  timeoutSec: z.number().int().min(1).max(MAX_HOOK_TIMEOUT_SEC),
  /** Boş dizi: tüm projeler. */
  projectIds: z.array(z.string().min(1).max(128)).max(MAX_HOOK_PROJECT_FILTER),
});
export type HookDefinition = z.infer<typeof hookDefinitionSchema>;

const configV1Schema = z.object({
  version: z.literal('1'),
  /** "Tüm kancaları duraklat" anahtarı. */
  paused: z.boolean(),
  hooks: z.array(hookDefinitionSchema).max(MAX_HOOKS),
});

export const lifecycleHooksConfig = defineVersionedSchema().initial('1', configV1Schema).build();

export type LifecycleHooksConfig = typeof lifecycleHooksConfig.Type;

/** Yazma girdisi: sürüm alanı sunucu tarafında sabitlenir, kimlikler tekrar edemez. */
export const lifecycleHooksConfigInputSchema = configV1Schema.superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [index, hook] of value.hooks.entries()) {
    if (seen.has(hook.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['hooks', index, 'id'],
        message: `Yinelenen kanca kimliği: ${hook.id}`,
      });
    }
    seen.add(hook.id);
  }
});

export function emptyLifecycleHooksConfig(): LifecycleHooksConfig {
  return { version: '1', paused: false, hooks: [] };
}

export type ValidateConfigResult =
  | { success: true; config: LifecycleHooksConfig }
  | { success: false; error: string };

/** Ham girdiyi doğrular (zod hata iletisini tek satıra indirger). */
export function validateLifecycleHooksConfig(input: unknown): ValidateConfigResult {
  const parsed = lifecycleHooksConfigInputSchema.safeParse(input);
  if (parsed.success) return { success: true, config: parsed.data };
  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return { success: false, error: `${path}${issue?.message ?? 'Geçersiz yapılandırma'}` };
}
