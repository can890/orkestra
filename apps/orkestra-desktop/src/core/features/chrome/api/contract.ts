import { defineContract, fallible, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

// Chrome köprüsü alanının Wire sözleşmesi. Eşleştirme belirteci yalnızca ana süreçte, şifreli
// uygulama sırları deposunda yaşar; yalnızca kullanıcının kopyalaması için `revealToken` ve
// `rotateToken` çıktılarında döner, durum çıktısında asla bulunmaz.

export const chromeDomain = 'chrome' as const;

/** Uzantının seçenekler sayfasındaki varsayılan bağlantı noktasıyla aynı olmalıdır. */
export const DEFAULT_CHROME_BRIDGE_PORT = 47653;

export const chromeBridgeStatusSchema = z.object({
  /** Kullanıcı köprüyü açtı mı? Varsayılan kapalıdır; kapalıyken hiçbir port dinlenmez. */
  enabled: z.boolean(),
  port: z.number().int(),
  /** 127.0.0.1 üzerinde şu anda dinleniyor mu? */
  listening: z.boolean(),
  /** Bir uzantı bağlı mı? Ajan araçları yalnızca bağlıyken sohbetlere eklenir. */
  connected: z.boolean(),
  listenError: z.string().nullable(),
  tokenSet: z.boolean(),
  /** Güvenli depolama (safeStorage) bu sistemde kullanılabilir mi? */
  secureStorageAvailable: z.boolean(),
});
export type ChromeBridgeStatus = z.infer<typeof chromeBridgeStatusSchema>;

export const chromeErrorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('storage_unavailable'), message: z.string() }),
  z.object({ type: z.literal('invalid_input'), message: z.string() }),
]);
export type ChromeError = z.infer<typeof chromeErrorSchema>;

const tokenResultSchema = z.object({ token: z.string() });

export const chromeContract = defineContract({
  getStatus: procedure({ input: z.void(), output: chromeBridgeStatusSchema }),
  configure: fallible({
    input: z.object({
      enabled: z.boolean().optional(),
      port: z.number().int().min(1024).max(65535).optional(),
    }),
    data: chromeBridgeStatusSchema,
    error: chromeErrorSchema,
  }),
  /** Eşleştirme belirtecini (yoksa üretip) kopyalanmak üzere döner. */
  revealToken: fallible({ input: z.void(), data: tokenResultSchema, error: chromeErrorSchema }),
  /** Yeni belirteç üretir; eski belirteç ve bağlı uzantı hemen geçersiz olur. */
  rotateToken: fallible({ input: z.void(), data: tokenResultSchema, error: chromeErrorSchema }),
  /** Bağlı uzantıyı keser; uzantı belirteçle yeniden bağlanmayı deneyebilir. */
  disconnect: procedure({ input: z.void(), output: z.void() }),
});

export type ChromeContract = typeof chromeContract;
