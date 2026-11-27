import { WireError, type Controller, type WireFile } from '@orkestra/wire/rpc';
import { z } from 'zod';
import { sidebarSnoozeInput } from '@core/primitives/mementos/api';
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
const mobileImage = z
  .object({
    name: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^/\\\u0000-\u001f]+$/u),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    data: z
      .string()
      .min(4)
      .max(349_528)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();

const sendPromptInput = z.object({
  conversationId: z.string().min(1).max(256),
  promptId: z.string().uuid(),
  prompt: z
    .object({
      text: z.string().max(100_000),
      // Mobil görseller yalnızca aşağıdaki kısıtlı bayt alanıyla alınır.
      hiddenContext: z.undefined().optional(),
      attachments: z.array(z.never()).max(0).optional(),
      mobileDelivery: z.literal(true).optional(),
      mobileImages: z.array(mobileImage).min(1).max(2).optional(),
    })
    .strict()
    .refine((prompt) => Boolean(prompt.text.trim() || prompt.mobileImages?.length))
    .refine((prompt) => !prompt.mobileImages || prompt.mobileDelivery === true),
  placement: z.enum(['auto', 'queue', 'steer']).optional(),
});
const loadHistoryInput = z.object({
  conversationId: z.string().min(1).max(256),
  before: z.number().int().optional(),
  limit: z.number().int().min(1).max(200),
});
// Telefon kendi sıraya aldığı mesajı silebilir ya da "Şimdi gönder" ile öne alabilir.
const deleteQueuedPromptInput = z
  .object({ conversationId: z.string().min(1).max(256), id: z.string().min(1).max(256) })
  .strict();
const changeQueuePromptOrderInput = z
  .object({
    conversationId: z.string().min(1).max(256),
    ids: z.array(z.string().min(1).max(256)).max(200),
  })
  .strict();
const resolvePermissionInput = z.object({
  conversationId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(512),
  optionId: z.string().min(1).max(512),
});
const resolveElicitationInput = z.object({
  conversationId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(512),
  action: z.enum(['accept', 'decline', 'cancel']),
  content: z
    .record(
      z.string().max(256),
      z.union([z.string().max(8000), z.number(), z.boolean(), z.array(z.string().max(1000)).max(64)])
    )
    .optional(),
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
        mode: z.enum(['fork', 'handoff', 'inline-handoff', 'context-handoff']),
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
    // Dosya boyutu sınırı yok: telefon çok GB'lık çıktıları aralık aralık (Range) oynatır.
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    // Çağrı başına üst sınır: base64 (4/3) + zarf 16 MiB çerçeve bütçesinin altında kalır.
    maxBytes: z
      .number()
      .int()
      .min(1024)
      .max(8 * 1024 * 1024)
      .optional(),
  })
  .strict();

const reviewWorkspaceInput = z.object({ workspaceId: z.string().min(1).max(256) }).strict();
const reviewPullRequestInput = reviewWorkspaceInput
  .extend({ url: z.string().min(1).max(2048) })
  .strict();
const reviewFileInput = reviewPullRequestInput
  .extend({
    path: z.string().min(1).max(1024),
    revision: z.string().min(1).max(4096),
  })
  .strict();

const generatePromptSuggestionsInput = z
  .object({
    lastUserText: z.string().max(2000).optional(),
    lastAssistantText: z.string().max(8000),
    projectName: z.string().max(200).optional(),
    taskName: z.string().max(200).optional(),
    activity: z
      .object({
        outcome: z.enum(['done', 'cancelled', 'error', 'interrupted']).optional(),
        editedFiles: z.array(z.string().max(300)).max(30).optional(),
        readFilesCount: z.number().int().nonnegative().optional(),
        executedCommands: z
          .array(
            z
              .object({
                command: z.string().max(400),
                failed: z.boolean().optional(),
              })
              .strict()
          )
          .max(20)
          .optional(),
        createdPlan: z.boolean().optional(),
        failedToolsCount: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
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
  'mementos.getSidebarSnoozes': guardWith(z.undefined()),
  'mementos.patchSidebarSnooze': guardWith(sidebarSnoozeInput),
  // Sohbet listeleri ve yeni ACP sohbeti başlatma
  'conversations.getConversations': null,
  'conversations.getConversationsForTask': null,
  'conversations.getConversationsForProject': null,
  'conversations.createConversation': guardWith(createConversationInput),
  'conversations.markConversationSeen': guardWith(conversationIdInput),
  'conversations.readMediaPreview': guardWith(readMediaPreviewInput),
  // Sohbeti sürdürme: oturumu bağla, geçmiş, prompt, iptal, yapılandırma, alt ajan ve devir
  'conversations.sideChat.get': guardWith(
    conversationIdInput.extend({ before: z.string().max(256).optional() }).strict()
  ),
  'conversations.sideChat.clear': guardWith(conversationIdInput.strict()),
  'conversations.sideChat.send': guardWith(
    conversationIdInput.extend({ text: z.string().trim().min(1).max(12_000) }).strict()
  ),

  'conversations.acp.attach': guardWith(conversationIdInput),
  'conversations.acp.loadHistory': guardWith(loadHistoryInput),
  'conversations.acp.sendPrompt': guardWith(sendPromptInput),
  'conversations.acp.cancelTurn': guardWith(conversationIdInput),
  'conversations.acp.deleteQueuedPrompt': guardWith(deleteQueuedPromptInput),
  'conversations.acp.changeQueuePromptOrder': guardWith(changeQueuePromptOrderInput),
  'conversations.acp.setOption': guardWith(setOptionInput),
  'conversations.acp.cancelSubagent': guardWith(cancelSubagentInput),
  'conversations.acp.resolvePermission': guardWith(resolvePermissionInput),
  'conversations.acp.resolveElicitation': guardWith(resolveElicitationInput),
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
  'sourceControl.review.list': guardWith(reviewWorkspaceInput),
  'sourceControl.review.files': guardWith(reviewPullRequestInput),
  'sourceControl.review.hunks': guardWith(reviewFileInput),
  'sourceControl.review.setViewed': guardWith(
    reviewFileInput
      .extend({ viewed: z.boolean(), account: z.string().regex(/^[0-9a-f]{64}$/) })
      .strict()
  ),
  // Bildirimler (yalnızca okundu/yok sayma durumu)
  'notifications.feed.markRead': null,
  'notifications.feed.markAllRead': null,
  'notifications.feed.dismiss': null,
  // Bağlam tabanlı takip önerileri (salt okunur)
  'textGeneration.generatePromptSuggestions': guardWith(generatePromptSuggestionsInput),
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

/**
 * Yalnızca uzak yüzeyde var olan domain'ler (masaüstü renderer sözleşmesinde yoktur; uzak erişim
 * servisi denetleyicilerini kendisi ekler). Şimdilik yalnızca ajan etkinliği akışı: başlık,
 * proje, durum ve kısa önizleme; sohbet içeriği ya da yol taşımaz.
 */
export const REMOTE_ONLY_PROCEDURES: Readonly<Record<string, Guard | null>> = {
  'agentActivity.getSnapshot': null,
};
export const REMOTE_ONLY_TOPICS: ReadonlySet<string> = new Set(['agentActivity.events']);

/**
 * Telefonun arka plan bildirim servisinin yardımcı kanalı (`notifications`) yalnızca bunları
 * görür: ajan etkinliği snapshot'ı ve canlı olayları. Prompt gönderme, izin yanıtlama vb. YOK.
 * Kanal aynı eşleştirme sırrıyla açıldığı için ek bir yetki sınırı değildir; amaç arka planda
 * sürekli açık duran bağlantının yüzeyini en aza indirmektir.
 */
export const REMOTE_NOTIFICATIONS_PROCEDURES: ReadonlySet<string> = new Set([
  'agentActivity.getSnapshot',
]);
export const REMOTE_NOTIFICATIONS_TOPICS: ReadonlySet<string> = new Set(['agentActivity.events']);

function topicRefId(topic: string): string {
  const index = topic.indexOf('|');
  return index === -1 ? topic : topic.slice(0, index);
}

export function isRemoteProcedureAllowed(path: string): boolean {
  return (
    Object.hasOwn(REMOTE_ALLOWED_PROCEDURES, path) || Object.hasOwn(REMOTE_ONLY_PROCEDURES, path)
  );
}

/** Konu dizesi `kimlik` ya da `kimlik|anahtar` biçimindedir (bkz. wire `splitTopic`). */
export function isRemoteTopicAllowed(topic: string): boolean {
  const refId = topicRefId(topic);
  return REMOTE_ALLOWED_TOPICS.has(refId) || REMOTE_ONLY_TOPICS.has(refId);
}

function remoteGuardFor(path: string): Guard | null {
  if (Object.hasOwn(REMOTE_ALLOWED_PROCEDURES, path))
    return REMOTE_ALLOWED_PROCEDURES[path] ?? null;
  if (Object.hasOwn(REMOTE_ONLY_PROCEDURES, path)) return REMOTE_ONLY_PROCEDURES[path] ?? null;
  return null;
}

type SurfacePolicy = {
  procedureAllowed(path: string): boolean;
  topicAllowed(topic: string): boolean;
};

const MAIN_POLICY: SurfacePolicy = {
  procedureAllowed: isRemoteProcedureAllowed,
  topicAllowed: isRemoteTopicAllowed,
};

const NOTIFICATIONS_POLICY: SurfacePolicy = {
  procedureAllowed: (path) => REMOTE_NOTIFICATIONS_PROCEDURES.has(path),
  topicAllowed: (topic) => REMOTE_NOTIFICATIONS_TOPICS.has(topicRefId(topic)),
};

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
  return createAllowlistController(controllers, MAIN_POLICY, payloadGuard);
}

/** Arka plan bildirim kanalının denetleyicisi: yalnızca ajan etkinliği akışı. */
export function createRemoteNotificationsSurfaceController(
  controllers: Record<string, Controller>,
  payloadGuard?: RemotePayloadGuardOptions
): Controller {
  return createAllowlistController(controllers, NOTIFICATIONS_POLICY, payloadGuard);
}

function wireImage(image: z.infer<typeof mobileImage>): WireFile {
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length > 256 * 1024 || bytes.toString('base64') !== image.data) {
    throw new WireError('CONTRACT_MISMATCH', 'Invalid mobile image encoding');
  }
  const format = image.mimeType;
  const valid =
    format === 'image/png'
      ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : format === 'image/jpeg'
        ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
        : format === 'image/gif'
          ? /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw new WireError('CONTRACT_MISMATCH', 'Invalid mobile image format');
  const meta = { name: image.name, mimeType: format, size: bytes.length };
  const stream = async function* () {
    yield bytes;
  };
  return {
    ...meta,
    stream,
    bytes: async () => bytes,
    file: async () => ({ ...meta, stream }),
    cancel() {},
  };
}

async function sendMobilePrompt(
  controller: Controller,
  path: string,
  input: z.infer<typeof sendPromptInput>
): Promise<unknown> {
  const { text, mobileImages } = input.prompt;
  const images = (mobileImages ?? []).map(wireImage);
  const attachments: { id: string; type: 'attachment'; name: string; mimeType: string }[] = [];
  let submissionStarted = false;
  let submitted = false;
  try {
    for (const image of images) {
      const uploaded = (await controller.call(
        'attachments.upload',
        {
          conversationId: input.conversationId,
        },
        { uploadFile: image }
      )) as { success: boolean; data?: { id: string } };
      if (!uploaded.success || !uploaded.data)
        return { success: false, error: { message: 'Görsel yüklenemedi.' } };
      attachments.push({
        id: uploaded.data.id,
        type: 'attachment',
        name: image.name,
        mimeType: image.mimeType,
      });
    }
    submissionStarted = true;
    const result = await controller.call(path, {
      ...input,
      prompt: { text, ...(attachments.length ? { attachments } : {}) },
    });
    submitted = (result as { success?: boolean })?.success === true;
    return result;
  } catch (error) {
    // Durumu belirsiz bir gönderimden sonra ekler kabul edilmiş olabilir.
    submitted = submissionStarted;
    throw error;
  } finally {
    if (!submitted) {
      await Promise.allSettled(
        attachments.map(({ id }) =>
          controller.call('attachments.delete', {
            conversationId: input.conversationId,
            attachmentId: id,
          })
        )
      );
    }
  }
}

function createAllowlistController(
  controllers: Record<string, Controller>,
  policy: SurfacePolicy,
  payloadGuard?: RemotePayloadGuardOptions
): Controller {
  const mobileReceipts = new Map<string, Promise<unknown>>();
  const settledReceipts = new Set<string>();
  return {
    async call(path, input, meta) {
      if (meta?.uploadFile || !policy.procedureAllowed(path)) {
        throw new WireError('UNKNOWN_PROCEDURE', `'${path}' is not available over remote access`);
      }
      const guard = remoteGuardFor(path);
      const violation = guard ? guard(input) : null;
      if (violation) throw new WireError('CONTRACT_MISMATCH', violation);
      const routed = routeToDomain(path, controllers);
      if (!routed) {
        throw new WireError('UNKNOWN_PROCEDURE', `'${path}' is not available over remote access`);
      }
      if (path === 'mementos.patchSidebarSnooze') {
        const { taskId, projectId, durationMs } = sidebarSnoozeInput.parse(input);
        if (durationMs !== null) {
          const conversations = await controllers.conversations?.call('getConversationsForTask', {
            taskId,
            projectId,
          });
          if (!Array.isArray(conversations) || conversations.length === 0) {
            throw new WireError('NOT_FOUND', 'Sohbet görevi bulunamadı.');
          }
        }
      }
      if (path === 'conversations.acp.sendPrompt') {
        const prompt = input as z.infer<typeof sendPromptInput>;
        if (prompt.prompt.mobileDelivery) {
          const key = JSON.stringify([prompt.conversationId, prompt.promptId]);
          const existing = mobileReceipts.get(key);
          if (existing) return existing;
          const receipt = sendMobilePrompt(routed.controller, routed.path, prompt);
          mobileReceipts.set(key, receipt);
          void receipt.then(
            (result) => {
              if ((result as { success?: unknown })?.success === true) {
                settledReceipts.add(key);
                if (settledReceipts.size > 2_048) {
                  const oldest = settledReceipts.values().next().value!;
                  settledReceipts.delete(oldest);
                  mobileReceipts.delete(oldest);
                }
              } else mobileReceipts.delete(key);
            },
            () => mobileReceipts.delete(key)
          );
          return receipt;
        }
      }
      const result = await routed.controller.call(routed.path, input, meta);
      if (path === 'conversations.acp.loadHistory') {
        return sanitizeRemoteHistoryResult(result, payloadGuard);
      }
      return result;
    },
    resolveLive(topic) {
      if (!policy.topicAllowed(topic)) return null;
      const routed = routeToDomain(topic, controllers);
      const source = routed ? routed.controller.resolveLive(routed.path) : null;
      return source ? wrapLiveSourceForRemote(topic, source, payloadGuard) : null;
    },
    acquireLive(topic) {
      if (!policy.topicAllowed(topic)) return null;
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
