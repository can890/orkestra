import { defineContract, fallible, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

// Dış ajanlar (Orkestra'nın başlatmadığı Claude Code, Codex, bot'lar) için yerel MCP sunucusunun
// ayar sözleşmesi. Yalnızca yerel renderer'ın ayar sayfası kullanır; uzak (mobil) yüzeye ve
// ajan araçlarına asla açılmaz. Özellik varsayılan olarak KAPALIDIR.

export const outsideAgentsDomain = 'outsideAgents' as const;

/** Sabit varsayılan port: istemci yapılandırması yeniden başlatmalardan sonra da geçerli kalsın. */
export const DEFAULT_OUTSIDE_AGENTS_PORT = 47660;

/** MCP uç noktasının yolu (`http://127.0.0.1:<port>/mcp`). */
export const OUTSIDE_AGENTS_MCP_PATH = '/mcp';

/** Bir istemcinin yetkisi: `read` yalnızca okur, `act` ayrıca sohbet başlatır ve mesaj gönderir. */
export const outsideAgentAccessSchema = z.enum(['read', 'act']);
export type OutsideAgentAccess = z.infer<typeof outsideAgentAccessSchema>;

export const MAX_OUTSIDE_AGENT_CLIENTS = 20;

export const outsideAgentClientNameSchema = z.string().trim().min(1).max(64);

export const outsideAgentClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  access: outsideAgentAccessSchema,
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
});
export type OutsideAgentClient = z.infer<typeof outsideAgentClientSchema>;

export const outsideAgentsStatusSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int(),
  /** 127.0.0.1 üzerinde şu anda dinleniyor mu? */
  listening: z.boolean(),
  /** Dinlenirken MCP adresi; kapalıyken null. */
  url: z.string().nullable(),
  listenError: z.string().nullable(),
  /** Güvenli depolama (safeStorage) bu sistemde kullanılabilir mi? */
  secureStorageAvailable: z.boolean(),
  clients: z.array(outsideAgentClientSchema),
});
export type OutsideAgentsStatus = z.infer<typeof outsideAgentsStatusSchema>;

export const outsideAgentsErrorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('storage_unavailable'), message: z.string() }),
  z.object({ type: z.literal('invalid_input'), message: z.string() }),
  z.object({ type: z.literal('not_found'), message: z.string() }),
  z.object({ type: z.literal('limit_reached'), message: z.string() }),
]);
export type OutsideAgentsError = z.infer<typeof outsideAgentsErrorSchema>;

export const outsideAgentSetupSchema = z.object({
  /** `claude mcp add ...` komutu (belirteç dahil). */
  claudeCode: z.string(),
  /** `~/.codex/config.toml` parçası (belirteç ortam değişkeninden okunur). */
  codexToml: z.string(),
  /** Codex için belirteci ortam değişkenine koyan kabuk satırı. */
  codexEnv: z.string(),
});
export type OutsideAgentSetup = z.infer<typeof outsideAgentSetupSchema>;

export const createdOutsideAgentClientSchema = z.object({
  client: outsideAgentClientSchema,
  /** Yalnızca bir kez gösterilir; Orkestra yalnızca özetini saklar. */
  token: z.string(),
  url: z.string(),
  setup: outsideAgentSetupSchema,
});
export type CreatedOutsideAgentClient = z.infer<typeof createdOutsideAgentClientSchema>;

export const outsideAgentsContract = defineContract({
  getStatus: procedure({ input: z.void(), output: outsideAgentsStatusSchema }),
  configure: fallible({
    input: z.object({
      enabled: z.boolean().optional(),
      port: z.number().int().min(1024).max(65535).optional(),
    }),
    data: outsideAgentsStatusSchema,
    error: outsideAgentsErrorSchema,
  }),
  /** Yeni istemci ve belirteci üretir; belirteç yalnızca bu yanıtta görünür. */
  createClient: fallible({
    input: z.object({ name: outsideAgentClientNameSchema, access: outsideAgentAccessSchema }),
    data: createdOutsideAgentClientSchema,
    error: outsideAgentsErrorSchema,
  }),
  setClientAccess: fallible({
    input: z.object({ id: z.string().min(1).max(64), access: outsideAgentAccessSchema }),
    data: outsideAgentsStatusSchema,
    error: outsideAgentsErrorSchema,
  }),
  /** İstemciyi siler; belirteci hemen geçersiz olur ve açık MCP oturumları kapanır. */
  revokeClient: fallible({
    input: z.object({ id: z.string().min(1).max(64) }),
    data: outsideAgentsStatusSchema,
    error: outsideAgentsErrorSchema,
  }),
});

export type OutsideAgentsContract = typeof outsideAgentsContract;
