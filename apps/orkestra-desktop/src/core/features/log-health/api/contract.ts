import { defineContract, liveModel, liveState, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

/**
 * Günlük sağlığı sözleşmesi: ana süreç günlük dosyasındaki warn/error kayıtlarını
 * tekrarlayan gruplara ayırır ve canlı model olarak yayınlar. Tüm metinler diske
 * yazılırken zaten maskelenmiştir; ana süreç örnekleri yayınlamadan önce yeniden maskeler.
 */

export const logHealthLevelSchema = z.enum(['warn', 'error', 'fatal']);
export type LogHealthLevel = z.infer<typeof logHealthLevelSchema>;

export const logHealthExampleSchema = z.object({
  /** ISO zaman damgası (son örneğin). */
  time: z.string(),
  proc: z.string().nullable(),
  /** Normalleştirilmemiş, maskelenmiş özgün mesaj. */
  message: z.string(),
  errorName: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** Kısaltılmış yığın izi. */
  stack: z.string().nullable(),
  /** Diğer alanlar; JSON olarak biçimlendirilmiş, kısaltılmış ve maskelenmiş. */
  fields: z.string().nullable(),
});
export type LogHealthExample = z.infer<typeof logHealthExampleSchema>;

export const logHealthGroupSchema = z.object({
  /** Normalleştirilmiş mesaj + hata imzasından türeyen kararlı anahtar. */
  key: z.string(),
  level: logHealthLevelSchema,
  /** Kimlikleri, sayıları ve yolları ayıklanmış mesaj şablonu. */
  template: z.string(),
  /** Normalleştirilmiş hata imzası (`Ad: mesaj`), yoksa null. */
  errorSignature: z.string().nullable(),
  count: z.number().int().nonnegative(),
  /** Bu uygulama oturumunda (süreç başlangıcından beri) görülen sayı. */
  sessionCount: z.number().int().nonnegative(),
  /** Kaydın görüldüğü farklı süreç kimliği (pid) sayısı; yaklaşık açılış sayısı. */
  launchCount: z.number().int().nonnegative(),
  /** Kaydın görüldüğü farklı gün sayısı. */
  dayCount: z.number().int().nonnegative(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  processes: z.array(z.string()),
  example: logHealthExampleSchema,
});
export type LogHealthGroup = z.infer<typeof logHealthGroupSchema>;

export const logHealthReportSchema = z.object({
  status: z.enum(['idle', 'scanning', 'ready', 'unavailable']),
  logFilePath: z.string().nullable(),
  /** Süreç başlangıç zamanı (ms); oturum sayımı bu andan itibaren yapılır. */
  sessionStartedAt: z.number(),
  /** Gruplamaya dahil edilen en eski zaman (ms). */
  windowStartedAt: z.number(),
  windowDays: z.number(),
  /** Başlangıç taraması bayt sınırına takıldıysa true. */
  truncated: z.boolean(),
  groups: z.array(logHealthGroupSchema),
});
export type LogHealthReport = z.infer<typeof logHealthReportSchema>;

export type RevealLogFileResult = { success: true } | { success: false; error: string };

export const logHealthDomain = 'logHealth' as const;

export const logHealthContract = defineContract({
  report: liveModel({
    key: z.void().optional(),
    states: {
      report: liveState({ data: logHealthReportSchema }),
    },
  }),
  revealLogFile: procedure({ input: z.void(), output: z.custom<RevealLogFileResult>() }),
});

export type LogHealthContract = typeof logHealthContract;
