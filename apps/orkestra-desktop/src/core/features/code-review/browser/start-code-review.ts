import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import type { ReviewFocus, ReviewScope } from '@core/features/code-review/api/review-model';
import {
  buildReviewPrompt,
  reviewConversationTitle,
} from '@core/features/code-review/api/review-prompt';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';

export type StartCodeReviewOptions = Readonly<{
  projectId: string;
  taskId: string;
  providerId: AgentProviderId;
  model: string | null;
  scope: ReviewScope;
  focus: readonly ReviewFocus[];
  instructions: string;
  autoApprove: boolean;
  /** İnceleme sohbetini sekme olarak aç (otomatik incelemede kapalı). */
  open: boolean;
}>;

/** Projenin varsayılan dalını git ref adı olarak döndürür (ör. `origin/main`); bilinmiyorsa null. */
export function resolveReviewBaseRef(projectId: string): string | null {
  const branch = getGitRepositoryStore(projectId)?.defaultBranch;
  if (!branch) return null;
  return branch.ref.replace(/^refs\/(?:heads|remotes)\//u, '') || null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'type' in error) return String(error.type);
  return String(error);
}

export function openConversationTab(projectId: string, taskId: string, conversationId: string) {
  getTaskComposition(projectId, taskId)?.paneLayout.open(
    'acp-chat',
    { conversationId },
    { preview: false }
  );
}

/**
 * Oturumu bağlayıp etkinleştirir (Orkestra işçileriyle aynı yol): bağlanan oturum geçmiş
 * isteğiyle etkinleşir ve ilk kuyruktaki istemi teslim eder. Sekme açık olmasa da çalışır.
 */
async function activateConversation(conversationId: string): Promise<void> {
  const client = (await getConversationsClient()).acp;
  const attached = await client.attach({ conversationId });
  if (!attached.success) throw new Error(`Oturum bağlanamadı: ${errorMessage(attached.error)}`);
  const history = await client.loadHistory({ conversationId, limit: 1 });
  if (!history.success) {
    throw new Error(`Oturum başlatılamadı: ${errorMessage(history.error)}`);
  }
}

/**
 * Görevde yeni bir ACP inceleme konuşması açar. İnceleme istemi ilk kuyruk olarak kaydedilir;
 * oturum hemen etkinleştirilemese bile sohbet ilk açıldığında çalışır.
 */
export async function startCodeReview(
  options: StartCodeReviewOptions
): Promise<{ conversationId: string }> {
  const manager = conversationRegistry.get(options.taskId);
  if (!manager) throw new Error('Görevin konuşmaları henüz yüklenmedi.');
  const baseRef = options.scope === 'branch' ? resolveReviewBaseRef(options.projectId) : null;
  const prompt = buildReviewPrompt({
    scope: options.scope,
    focus: options.focus,
    baseRef,
    instructions: options.instructions,
  });
  const conversationId = crypto.randomUUID();
  await manager.createConversation({
    id: conversationId,
    projectId: options.projectId,
    taskId: options.taskId,
    provider: options.providerId,
    title: reviewConversationTitle(options.scope, baseRef),
    autoApprove: options.autoApprove,
    ...(options.model ? { model: options.model } : {}),
    type: 'acp',
    initialQueue: [{ text: prompt.text, hiddenContext: prompt.hiddenContext }],
  });
  if (options.open) openConversationTab(options.projectId, options.taskId, conversationId);
  await activateConversation(conversationId);
  return { conversationId };
}

export type FollowUpDelivery = 'sent' | 'copied';

/**
 * Bir konuşmaya takip istemi gönderir. Sohbet arayüzü (ACP) olmayan konuşmalara çok satırlı
 * metin güvenle yazılamadığından istem panoya kopyalanır.
 */
export async function sendFollowUpPrompt(
  projectId: string,
  taskId: string,
  conversationId: string,
  text: string
): Promise<FollowUpDelivery> {
  const conversation = conversationRegistry.get(taskId)?.conversations.get(conversationId);
  if (conversation?.data.type !== 'acp') {
    await navigator.clipboard.writeText(text);
    return 'copied';
  }
  const client = (await getConversationsClient()).acp;
  const attached = await client.attach({ conversationId });
  if (!attached.success) throw new Error(`Oturum bağlanamadı: ${errorMessage(attached.error)}`);
  const sent = await client.sendPrompt(
    { conversationId, promptId: crypto.randomUUID(), prompt: { text } },
    { timeoutMs: 0 }
  );
  if (!sent.success) throw new Error(`İstem gönderilemedi: ${errorMessage(sent.error)}`);
  openConversationTab(projectId, taskId, conversationId);
  return 'sent';
}
