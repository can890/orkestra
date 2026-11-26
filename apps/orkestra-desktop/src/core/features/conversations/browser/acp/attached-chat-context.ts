import type { MentionItem } from '@orkestra/ui/react/components';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { acpChatRegistry } from './acp-chat-registry';
import { transcriptTurns } from './subagent-activity';

export const COMPOSER_DROP_ZONE_ATTR = 'data-composer-drop-zone';
export const COMPOSER_DRAG_OVER_ATTR = 'data-chat-drag-over';
export const ATTACH_CHAT_CONTEXT_EVENT = 'sovra:attach-chat-context';

export interface AttachedChatRef {
  projectId: string;
  taskId: string;
  title: string;
}

export interface AttachChatContextEventDetail extends AttachedChatRef {
  targetConversationId: string;
}

/**
 * Verilen noktanın altında bir sohbet composer bırakma bölgesi varsa o elemanı döndürür.
 */
export function findComposerDropZoneAt(point: { x: number; y: number }): HTMLElement | null {
  if (typeof document === 'undefined' || !document.elementsFromPoint) return null;
  const elements = document.elementsFromPoint(point.x, point.y);
  for (const el of elements) {
    if (el instanceof HTMLElement) {
      const zone = el.closest<HTMLElement>(`[${COMPOSER_DROP_ZONE_ATTR}]`);
      if (zone) return zone;
    }
  }
  return null;
}

export function clearComposerDropHighlights(): void {
  if (typeof document === 'undefined') return;
  for (const el of document.querySelectorAll<HTMLElement>(`[${COMPOSER_DRAG_OVER_ATTR}]`)) {
    el.removeAttribute(COMPOSER_DRAG_OVER_ATTR);
  }
}

/**
 * `@` mention araması için açık projelerdeki son sohbet/görevleri döndürür.
 */
export function searchRecentChatMentions(
  query: string,
  excludeTaskId?: string,
  limit = 6
): MentionItem[] {
  const q = query.trim().toLowerCase();
  const projectManager = getProjectManagerStore();
  const matches: Array<{ projectId: string; taskId: string; name: string; updatedAt: number }> = [];

  for (const project of projectManager.projects.values()) {
    const projectId = project.data?.id;
    if (!projectId) continue;
    const taskManager = getTaskManagerStore(projectId);
    if (!taskManager) continue;
    for (const task of taskManager.tasks.values()) {
      const tData = task.data as {
        id: string;
        name?: string;
        isArchived?: boolean;
        updatedAt?: string;
        createdAt?: string;
      };
      if (tData.id === excludeTaskId) continue;
      if (tData.isArchived) continue;
      const name = (tData.name || '').trim();
      if (!name) continue;
      if (q && !name.toLowerCase().includes(q)) continue;
      const updated = Date.parse(tData.updatedAt ?? tData.createdAt ?? '') || 0;
      matches.push({
        projectId,
        taskId: tData.id,
        name,
        updatedAt: updated,
      });
    }
  }

  matches.sort((a, b) => b.updatedAt - a.updatedAt);
  return matches.slice(0, limit).map((item) => ({
    id: `chat:${item.projectId}:${item.taskId}`,
    label: `sohbet:${item.name}`,
    name: item.name,
    kind: 'custom',
    description: 'Sohbet bağlamı',
    meta: JSON.stringify({ projectId: item.projectId, taskId: item.taskId, title: item.name }),
  }));
}

/**
 * Bağlanan bir sohbetin son mesajlarını okuyup ajana verilecek `<referenced_chat>` bloğuna çevirir.
 */
export async function buildReferencedChatsContext(
  refs: readonly AttachedChatRef[]
): Promise<string | undefined> {
  if (refs.length === 0) return undefined;
  const blocks: string[] = [];

  for (const ref of refs) {
    const lines: string[] = [];
    // 1. Önce bellekteki canlı AcpChatStore'dan oku.
    const liveStores = acpChatRegistry.getAll(ref.taskId);
    const liveStore = liveStores ? [...liveStores.values()][0] : undefined;
    if (liveStore) {
      const turns = transcriptTurns(liveStore.chatState.transcript.state);
      for (const turn of turns.slice(-8)) {
        for (const item of turn.items) {
          if (item.kind === 'message' && item.text.trim()) {
            const roleLabel = item.role === 'user' ? 'Kullanıcı' : 'Asistan';
            lines.push(`[${roleLabel}]: ${item.text.trim().slice(0, 700)}`);
          }
        }
      }
    }

    // 2. Bellekte yoksa kayıtlı sohbet önbelleğinden / diskten oku.
    if (lines.length === 0) {
      const convManager = conversationRegistry.get(ref.taskId);
      const convId = convManager ? [...convManager.conversations.keys()][0] : undefined;
      if (convId) {
        try {
          const acpClient = (await getConversationsClient()).acp as {
            getCachedHistory?: (input: { conversationId: string }) => Promise<{
              turns: Array<{ items: Array<{ kind: string; role?: string; text?: string }> }>;
            }>;
          };
          const cached = await acpClient.getCachedHistory?.({ conversationId: convId });
          for (const turn of (cached?.turns ?? []).slice(-8)) {
            for (const item of turn.items) {
              if (item.kind === 'message' && typeof item.text === 'string' && item.text.trim()) {
                const roleLabel = item.role === 'user' ? 'Kullanıcı' : 'Asistan';
                lines.push(`[${roleLabel}]: ${item.text.trim().slice(0, 700)}`);
              }
            }
          }
        } catch {
          // Okunamazsa yalnızca başlığı referans olarak ekle.
        }
      }
    }

    const body =
      lines.length > 0
        ? lines.slice(-14).join('\n\n')
        : '(Sohbet özeti okunamadı; yalnız sohbet başlığı referans verildi.)';
    blocks.push(`<referenced_chat title="${ref.title.replace(/"/g, "'")}">\n${body}\n</referenced_chat>`);
  }

  return blocks.length > 0 ? blocks.join('\n\n') : undefined;
}
