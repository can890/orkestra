import { z } from 'zod';
import { hookEventSchema } from './hook-config';

/** Kanca çalıştırma günlüğü kaydı (bellekte; kanca başına son 20). */
export const hookRunStatusSchema = z.enum(['ok', 'failed', 'timeout', 'skipped', 'error']);
export type HookRunStatus = z.infer<typeof hookRunStatusSchema>;

export const hookRunRecordSchema = z.object({
  id: z.string(),
  hookId: z.string(),
  event: hookEventSchema,
  /** Epoch ms. */
  startedAt: z.number(),
  durationMs: z.number(),
  status: hookRunStatusSchema,
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  /** Atlama/hata nedeni (Türkçe kısa metin). */
  note: z.string().nullable(),
  /** Kırpılmış ve gizli bilgilerden arındırılmış çıktı kuyrukları. */
  stdoutTail: z.string(),
  stderrTail: z.string(),
});
export type HookRunRecord = z.infer<typeof hookRunRecordSchema>;

export const MAX_RUNS_PER_HOOK = 20;
export const RUN_OUTPUT_TAIL_CHARS = 2_000;
