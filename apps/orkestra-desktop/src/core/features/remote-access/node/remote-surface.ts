import { WireError, type Controller } from '@orkestra/wire/rpc';
import { z } from 'zod';
import {
  sanitizeRemoteHistoryResult,
  wrapLiveSourceForRemote,
  type RemotePayloadGuardOptions,
} from './remote-payload-guard';

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
const resolveRepositoryDestinationInput = z
  .object({
    host: z.object({ type: z.literal('local') }).strict(),
    name: z.string().trim().min(1).max(120),
  })
  .strict();
const createProjectInput = z
  .object({
    type: z.literal('local'),
    name: z.string().trim().min(1).max(120),
    path: z.string().trim().min(1).max(512),
    initGitRepository: z.boolean().optional(),
  })
  .strict();
const createTaskInput = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().min(1).max(256),
    taskConfig: z
      .object({
        version: z.literal('1'),
        name: z.string().trim().min(1).max(200),
        initialConversation: z
          .object({
            id: z.string().uuid(),
            provider: z.string().min(1).max(64),
            title: z.string().trim().min(1).max(200).optional(),
            initialPrompt: z.string().max(100_000).optional(),
            type: z.literal('acp'),
          })
          .strict()
          .optional(),
      })
      .strict(),
    workspaceConfig: z
      .object({
        version: z.literal('2'),
        git: z.object({ kind: z.literal('none') }).strict(),
        workspace: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('new-worktree') }).strict(),
          z
            .object({
              kind: z.literal('repository-instance'),
              workspaceId: z.string().min(1).max(256),
            })
            .strict(),
        ]),
      })
      .strict(),
  })
  .strict();
const createConversationInput = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().min(1).max(256),
    taskId: z.string().min(1).max(256),
    provider: z.string().min(1).max(64),
    title: z.string().trim().min(1).max(200),
    initialPrompt: z.string().max(100_000).optional(),
    type: z.literal('acp'),
  })
  .strict();
const setOptionInput = z
  .object({
    conversationId: z.string().min(1).max(256),
    key: z.enum(['model', 'mode', 'effort', 'collaborationMode']),
    value: z.string().min(1).max(256),
  })
  .strict();
const cancelSubagentInput = z
  .object({
    conversationId: z.string().min(1).max(256),
    runId: z.string().uuid(),
  })
  .strict();
const handoffChainSegmentSchema = z
  .object({
    conversationId: z.string().min(1).max(256),
    fromProviderId: z.string().min(1).max(64),
    fromModelLabel: z.string().min(1).max(256),
    toProviderId: z.string().min(1).max(64),
    toModelLabel: z.string().min(1).max(256),
    createdAt: z.number().finite(),
  })
  .strict();
const handoffPutInput = z
  .object({
    conversationId: z.string().min(1).max(256),
    record: z
      .object({
        version: z.literal(1),
        mode: z.enum(['fork', 'handoff', 'inline-handoff']),
        sourceConversationId: z.string().min(1).max(256),
        sourceTitle: z.string().min(1).max(300),
        sourceItemId: z.string().min(1).max(256).optional(),
        context: z.string().min(0).max(50_000),
        contextDelivered: z.boolean().optional(),
        createdAt: z.number().finite(),
        targetEffort: z.string().min(1).max(64).optional(),
        chain: z.array(handoffChainSegmentSchema).max(32).optional(),
      })
      .strict(),
  })
  .strict();
const handoffMarkSupersededInput = z
  .object({
    oldConversationId: z.string().min(1).max(256),
    newConversationId: z.string().min(1).max(256),
  })
  .strict();
const changedFilesInput = z
  .object({
    workspaceId: z.string().min(1).max(256),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('staged-vs-head') }).strict(),
      z.object({ kind: z.literal('working-vs-index') }).strict(),
    ]),
  })
  .strict();
const fileHunksInput = z
  .object({
    workspaceId: z.string().min(1).max(256),
    path: z.string().min(1).max(1024),
    scope: z.enum(['unstaged', 'staged']),
  })
  .strict();

const readMediaPreviewInput = z
  .object({
    conversationId: z.string().min(1).max(256),
    uri: z.string().min(1).max(2048),
    offset: z.number().int().min(0).max(40 * 1024 * 1024).optional(),
    maxBytes: z.number().int().min(1024).max(1_600_000).optional(),
  })
  .strict();

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
  // Proje ve görev başlatma (sıkı şema korumalı, yalnızca yerel + ACP)
  'projects.resolveRepositoryDestination': guardWith(resolveRepositoryDestinationInput),
  'projects.createProject': guardWith(createProjectInput),
  'projects.ensureFreeChatProject': null,
  'tasks.createTask': guardWith(createTaskInput),
  // Sohbet listeleri ve yeni ACP sohbeti başlatma
  'conversations.getConversations': null,
  'conversations.getConversationsForTask': null,
  'conversations.getConversationsForProject': null,
  'conversations.createConversation': guardWith(createConversationInput),
  'conversations.markConversationSeen': guardWith(conversationIdInput),
  'conversations.readMediaPreview': guardWith(readMediaPreviewInput),
  // Sohbeti sürdürme: oturumu bağla, geçmiş, prompt, iptal, yapılandırma, alt ajan ve devir
  'conversations.acp.attach': guardWith(conversationIdInput),
  'conversations.acp.loadHistory': guardWith(loadHistoryInput),
  'conversations.acp.sendPrompt': guardWith(sendPromptInput),
  'conversations.acp.cancelTurn': guardWith(conversationIdInput),
  'conversations.acp.setOption': guardWith(setOptionInput),
  'conversations.acp.cancelSubagent': guardWith(cancelSubagentInput),
  'conversations.acp.resolvePermission': guardWith(resolvePermissionInput),
  'conversations.handoff.listAll': null,
  'conversations.handoff.put': guardWith(handoffPutInput),
  'conversations.handoff.markSuperseded': guardWith(handoffMarkSupersededInput),
  // Ajan listesi, bağlı hesaplar ve kullanım limitleri (salt okunur)
  'agents.listMetadata': null,
  'agents.accountUsage': null,
  'usageLimits.get': null,
  // Git değişen dosyalar ve hunk görünümü (salt okunur)
  'sourceControl.checkout.getChangedFiles': guardWith(changedFilesInput),
  'sourceControl.checkout.getFileHunks': guardWith(fileHunksInput),
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
export function createRemoteSurfaceController(
  controllers: Record<string, Controller>,
  payloadGuard?: RemotePayloadGuardOptions
): Controller {
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
      const result = await routed.controller.call(routed.path, input, meta);
      if (path === 'conversations.acp.loadHistory') {
        return sanitizeRemoteHistoryResult(result, payloadGuard);
      }
      return result;
    },
    resolveLive(topic) {
      if (!isRemoteTopicAllowed(topic)) return null;
      const routed = routeToDomain(topic, controllers);
      const source = routed ? routed.controller.resolveLive(routed.path) : null;
      return source ? wrapLiveSourceForRemote(topic, source, payloadGuard) : null;
    },
    acquireLive(topic) {
      if (!isRemoteTopicAllowed(topic)) return null;
      const routed = routeToDomain(topic, controllers);
      const lease = routed ? routed.controller.acquireLive(routed.path) : null;
      if (!lease) return null;
      // Kiralama kaynağı `ready()` ile verilir; koruma, tüketicinin aldığı kaynağa uygulanmalı.
      return {
        ready: async () => wrapLiveSourceForRemote(topic, await lease.ready(), payloadGuard),
        release: () => lease.release(),
      };
    },
  };
}
