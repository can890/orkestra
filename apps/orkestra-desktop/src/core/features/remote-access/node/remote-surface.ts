import { WireError, type Controller } from '@orkestra/wire/rpc';
import { z } from 'zod';

/**
 * UZAK (MOBİL) OTURUMLARA AÇILAN YÜZEYİN TEK KAYNAĞI.
 *
 * Bu dosya bir İZİN LİSTESİDİR: burada adı geçmeyen her Wire yordamı ve canlı konu, varsayılan
 * olarak reddedilir (`UNKNOWN_PROCEDURE` / `UNKNOWN_TOPIC`). Yeni bir uç nokta eklenince uzak
 * yüzeye KENDİLİĞİNDEN girmez. Şunlar hiçbir koşulda eklenmez: sırlar ve token'lar, SSH kimlik
 * bilgileri, hesap/sağlayıcı oturum açma, terminal/PTY, dosya yazma/okuma ve ayar değiştirme,
 * proje/görev oluşturma-silme, MCP, entegrasyon ve `remoteAccess` (eşleştirme) alanı.
 *
 * Liste `agents/architecture/remote-access.md` ile eşleşmelidir (remote-surface.test.ts denetler).
 */

type Guard = (input: unknown) => string | null;

const conversationIdInput = z.object({ conversationId: z.string().min(1).max(256) });
const sendPromptInput = z.object({
  conversationId: z.string().min(1).max(256),
  promptId: z.string().uuid(),
  prompt: z
    .object({
      text: z.string().min(1).max(100_000),
      // Gizli bağlam ve ek dosyalar uzak yüzeyde yok: dosya yolu/yerel içerik taşıyabilir.
      hiddenContext: z.undefined().optional(),
      attachments: z.array(z.never()).max(0).optional(),
    })
    .strict(),
  placement: z.enum(['auto', 'queue']).optional(),
});
const loadHistoryInput = z.object({
  conversationId: z.string().min(1).max(256),
  before: z.number().int().optional(),
  limit: z.number().int().min(1).max(200),
});
const resolvePermissionInput = z.object({
  conversationId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(512),
  optionId: z.string().min(1).max(512),
});

function guardWith(schema: z.ZodType): Guard {
  return (input) => {
    const parsed = schema.safeParse(input);
    return parsed.success ? null : 'invalid input for remote access';
  };
}

/**
 * İzinli yordamlar: tam yol → isteğe bağlı girdi koruması. Koruma, aşağıdaki denetleyicinin kendi
 * şema doğrulamasının ÜSTÜNE ek kısıtlar koyar (ör. prompt'ta ek dosya yok).
 */
export const REMOTE_ALLOWED_PROCEDURES: Readonly<Record<string, Guard | null>> = {
  // Sohbet listeleri (salt okunur)
  'conversations.getConversations': null,
  'conversations.getConversationsForTask': null,
  'conversations.getConversationsForProject': null,
  'conversations.markConversationSeen': guardWith(conversationIdInput),
  // Sohbeti sürdürme: oturumu bağla, geçmiş, prompt, iptal, izin isteğine yanıt
  'conversations.acp.attach': guardWith(conversationIdInput),
  'conversations.acp.loadHistory': guardWith(loadHistoryInput),
  'conversations.acp.sendPrompt': guardWith(sendPromptInput),
  'conversations.acp.cancelTurn': guardWith(conversationIdInput),
  'conversations.acp.resolvePermission': guardWith(resolvePermissionInput),
  // Ajan listesi, bağlı hesaplar ve kullanım limitleri (salt okunur)
  'agents.listMetadata': null,
  'agents.accountUsage': null,
  'usageLimits.get': null,
  // Bildirimler (yalnızca okundu/yok sayma durumu)
  'notifications.feed.markRead': null,
  'notifications.feed.markAllRead': null,
  'notifications.feed.dismiss': null,
};

/**
 * İzinli canlı konular (konu kimliği, anahtar kısmı hariç). `terminals`, `mcpServers` ve
 * `terminalOutput` bilerek yok: komut satırı/çıktı ve MCP yapılandırması taşıyabilirler.
 */
export const REMOTE_ALLOWED_TOPICS: ReadonlySet<string> = new Set([
  'projects.projectList.list',
  'tasks.taskList.list',
  'tasks.taskStats.stats',
  'conversations.events',
  'conversations.acp.sessions.list',
  'conversations.acp.session.state',
  'conversations.acp.session.config',
  'conversations.acp.session.usage',
  'conversations.acp.session.plan',
  'conversations.acp.session.agents',
  'conversations.acp.session.activeTurn',
  'agents.auth.list',
  'notifications.feed.list',
  'notifications.delivery',
]);

export function isRemoteProcedureAllowed(path: string): boolean {
  return Object.hasOwn(REMOTE_ALLOWED_PROCEDURES, path);
}

/** Konu dizesi `kimlik` ya da `kimlik|anahtar` biçimindedir (bkz. wire `splitTopic`). */
export function isRemoteTopicAllowed(topic: string): boolean {
  const index = topic.indexOf('|');
  const refId = index === -1 ? topic : topic.slice(0, index);
  return REMOTE_ALLOWED_TOPICS.has(refId);
}

/** `domain.rest` yollarını ilgili alan denetleyicisine yönlendirir (masaüstü gateway'iyle aynı kural). */
function routeToDomain(path: string, controllers: Record<string, Controller>) {
  const [prefix, ...rest] = path.split('.');
  const controller = prefix === undefined ? undefined : controllers[prefix];
  if (!controller || rest.length === 0) return null;
  return { controller, path: rest.join('.') };
}

/**
 * Masaüstü denetleyicilerini izin listesiyle sarar. Kimliği doğrulanmış her uzak oturum
 * yalnızca bu denetleyiciyi görür. Yüklemeler (`meta.uploadFile`) her zaman reddedilir;
 * `dispose` bilerek yoktur (alttaki denetleyiciler uygulamaya aittir).
 */
export function createRemoteSurfaceController(controllers: Record<string, Controller>): Controller {
  return {
    async call(path, input, meta) {
      if (meta?.uploadFile || !isRemoteProcedureAllowed(path)) {
        throw new WireError('UNKNOWN_PROCEDURE', `'${path}' is not available over remote access`);
      }
      const guard = REMOTE_ALLOWED_PROCEDURES[path];
      const violation = guard ? guard(input) : null;
      if (violation) throw new WireError('CONTRACT_MISMATCH', violation);
      const routed = routeToDomain(path, controllers);
      if (!routed) {
        throw new WireError('UNKNOWN_PROCEDURE', `'${path}' is not available over remote access`);
      }
      return await routed.controller.call(routed.path, input, meta);
    },
    resolveLive(topic) {
      if (!isRemoteTopicAllowed(topic)) return null;
      const routed = routeToDomain(topic, controllers);
      return routed ? routed.controller.resolveLive(routed.path) : null;
    },
    acquireLive(topic) {
      if (!isRemoteTopicAllowed(topic)) return null;
      const routed = routeToDomain(topic, controllers);
      return routed ? routed.controller.acquireLive(routed.path) : null;
    },
  };
}
