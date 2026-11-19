import { defineContract, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';
import { lifecycleHooksConfigInputSchema } from './hook-config';
import { hookRunRecordSchema } from './hook-runs';

/**
 * Kancalar sözleşmesi. Kanca tanımları YALNIZCA bu sözleşmeden (Ayarlar → Kancalar sayfası,
 * renderer) yazılabilir; ajan araçları, MCP, depo dosyaları ve uzak erişim bu yüzeye
 * ulaşmaz (bkz. `node/hook-write-surface.test.ts`).
 */

export const lifecycleHooksStateSchema = z.object({
  config: lifecycleHooksConfigInputSchema,
  /** `ok` dışındaki durumlarda dosyadaki yapılandırma yok sayılmış ve kancalar kapalıdır. */
  status: z.enum(['ok', 'tampered', 'invalid', 'future-version', 'unavailable']),
});
export type LifecycleHooksState = z.infer<typeof lifecycleHooksStateSchema>;

export const saveLifecycleHooksResultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), state: lifecycleHooksStateSchema }),
  z.object({ success: z.literal(false), error: z.string() }),
]);
export type SaveLifecycleHooksResult = z.infer<typeof saveLifecycleHooksResultSchema>;

export const lifecycleHooksDomain = 'lifecycleHooks' as const;

export const lifecycleHooksContract = defineContract({
  getState: procedure({ input: z.void(), output: lifecycleHooksStateSchema }),
  saveConfig: procedure({
    input: lifecycleHooksConfigInputSchema,
    output: saveLifecycleHooksResultSchema,
  }),
  listRuns: procedure({ input: z.void(), output: z.array(hookRunRecordSchema) }),
  clearRuns: procedure({ input: z.void(), output: z.void() }),
});

export type LifecycleHooksContract = typeof lifecycleHooksContract;
