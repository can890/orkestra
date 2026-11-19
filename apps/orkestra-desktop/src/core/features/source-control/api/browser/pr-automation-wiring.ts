import { toast } from '@orkestra/ui/react/primitives';
import { pickMainConversation } from '@core/features/code-review/api/review-participants';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import type { ConversationManagerStore } from '@core/features/conversations/api/browser/conversation-manager';
import type { PrStore } from '@core/features/source-control/api/browser/stores/pr-store';
import { log } from '@core/primitives/logging/browser/logger';
import type { AgentAvailability, AutoFixComment } from '../pr-automation';
import {
  PrAutomationStore,
  type PrAutomationHandle,
  type PrAutomationSnapshot,
} from './stores/pr-automation-store';

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'type' in error) return String(error.type);
  return String(error);
}

/** Ajanın meşgul olup olmadığı: çalışan ya da izin/girdi bekleyen herhangi bir konuşma. */
export function agentAvailability(conversations: ConversationManagerStore): AgentAvailability {
  const all = [...conversations.conversations.values()];
  const main = pickMainConversation(all.map((conversation) => conversation.data));
  if (!main || main.type !== 'acp') return { kind: 'none' };
  const busy = all.some(
    (conversation) => conversation.status === 'working' || conversation.status === 'awaiting-input'
  );
  return busy ? { kind: 'busy' } : { kind: 'idle' };
}

function snapshotOf(prStore: PrStore): PrAutomationSnapshot | null {
  const details = prStore.details;
  const pr = details?.pr ?? prStore.currentPr;
  if (!pr) return null;
  const items: AutoFixComment[] = (details?.comments ?? []).map((comment) => ({
    id: comment.id,
    kind: comment.kind,
    body: comment.body,
    url: comment.url,
    path: comment.path,
    line: comment.line,
    isResolved: comment.isResolved,
    isOutdated: comment.isOutdated,
    authorUserId: comment.author?.userId ?? null,
    authorName: comment.author?.userName ?? null,
  }));
  return {
    pr: {
      url: pr.url,
      status: pr.status,
      isDraft: pr.isDraft,
      headRefOid: pr.headRefOid,
      authorUserId: pr.author?.userId ?? null,
      checks: pr.checks,
    },
    comments: {
      fetched: details?.commentsFetchedAt != null && !details.errors.comments,
      items,
    },
  };
}

/**
 * Görevin ajanına (ana ACP konuşması) prompt gönderir; sekmeyi açmaz ya da odağı çalmaz.
 * Konuşma ACP değilse hiçbir şey gönderilmez.
 */
async function sendToMainConversation(
  conversations: ConversationManagerStore,
  text: string
): Promise<{ success: true } | { success: false; error: string }> {
  const main = pickMainConversation(
    [...conversations.conversations.values()].map((conversation) => conversation.data)
  );
  if (!main || main.type !== 'acp') return { success: false, error: 'Uygun bir sohbet yok' };
  try {
    const client = (await getConversationsClient()).acp;
    const attached = await client.attach({ conversationId: main.id });
    if (!attached.success) {
      return { success: false, error: `Oturum bağlanamadı: ${errorMessage(attached.error)}` };
    }
    const sent = await client.sendPrompt(
      { conversationId: main.id, promptId: crypto.randomUUID(), prompt: { text } },
      { timeoutMs: 0 }
    );
    return sent.success
      ? { success: true }
      : { success: false, error: `İstem gönderilemedi: ${errorMessage(sent.error)}` };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

export function createPrAutomationStore(options: {
  projectId: string;
  taskId: string;
  handle: PrAutomationHandle;
  prStore: PrStore;
  conversations: ConversationManagerStore;
}): PrAutomationStore {
  const { prStore, conversations } = options;
  return new PrAutomationStore({
    handle: options.handle,
    read: () => snapshotOf(prStore),
    agent: () => agentAvailability(conversations),
    sendPrompt: (text) => sendToMainConversation(conversations, text),
    report: {
      sent: (summary) => {
        log.info('[pr-automation] Ajana düzeltme isteği gönderildi', {
          taskId: options.taskId,
          summary,
        });
        toast('PR otomasyonu ajana düzeltme isteği gönderdi', { description: summary });
      },
      failed: (summary, error) => {
        log.warn('[pr-automation] Düzeltme isteği gönderilemedi', {
          taskId: options.taskId,
          summary,
          error,
        });
        toast.error('PR otomasyonu isteği gönderemedi', { description: error });
      },
      blocked: (message) => {
        log.warn('[pr-automation] Otomatik düzeltme durduruldu', {
          taskId: options.taskId,
          message,
        });
        toast.warning('Otomatik düzeltme durdu', { description: message });
      },
    },
  });
}
