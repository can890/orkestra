import type { ChatItem, PrefixTranscriptTurn } from '@orkestra/chat-ui';
import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import {
  nextDefaultConversationTitle,
  visibleConversationTitle,
} from '@core/features/conversations/api/browser/conversation-title-utils';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { buildHandoffSummary } from '@core/features/conversations/api/handoff-summary';
import {
  getProjectStore,
  projectData,
} from '@core/features/projects/api/browser/stores/project-selectors';
import {
  asProvisioned,
  getRegisteredTaskData,
  getTaskManagerStore,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { collectHistoryTurns, type HistoryPageResult } from './handoff-history';
import { getHandoffStore, setCachedPrefixTurns } from './handoff-store';
import type { VisibleTurnLike } from './switch-provider-in-place';

const FORK_SUFFIX = ' fork';

function rewriteForkItem(item: ChatItem, prefix: string): ChatItem {
  const nextId = `${prefix}:${item.id}`;
  const raw = item as ChatItem & { parentId?: string; children?: readonly ChatItem[] };
  if (!raw.parentId && !raw.children?.length) {
    return { ...item, id: nextId } as ChatItem;
  }
  return {
    ...raw,
    id: nextId,
    ...(raw.parentId ? { parentId: `${prefix}:${raw.parentId}` } : {}),
    ...(raw.children ? { children: raw.children.map((child) => rewriteForkItem(child, prefix)) } : {}),
  } as ChatItem;
}

function isPrefixTurnLike(turn: VisibleTurnLike): boolean {
  if (
    turn.id.startsWith('seg:') ||
    turn.id.startsWith('fork:') ||
    turn.id.startsWith('handoff-divider:')
  ) {
    return true;
  }
  return (turn.items as readonly ChatItem[]).some((item) => item.kind === 'handoff-divider');
}

function turnContainsItem(
  turn: { items: readonly { id?: string; children?: readonly { id?: string }[] }[] },
  targetItemId: string
): boolean {
  return turn.items.some(
    (item) =>
      item.id === targetItemId ||
      Boolean(item.children?.some((child) => child.id === targetItemId))
  );
}

/**
 * T3 Code ile uyumlu yan panel / başlık formatı: kaynak başlığın sonuna ` fork` ekler.
 * Zaten ` fork` ile bitiyorsa tekrar eklemez; eski ` (çatal)` ekini temizler.
 */
export function forkTaskTitle(sourceName: string): string {
  const trimmed = sourceName.trim();
  const normalized = (trimmed.replace(/\s*\(çatal\)$/i, '').trim() || 'Sohbet');
  if (normalized.toLowerCase().endsWith(FORK_SUFFIX)) {
    return normalized;
  }
  return `${normalized}${FORK_SUFFIX}`;
}

/**
 * Konuşma turlarını belirtilen öğe kimliğine (`upToItemId`) kadar (kendisi dahil) keser.
 * `upToItemId` verilmezse veya turlarda bulunamazsa tüm turları döndürür.
 */
export function sliceTurnsUpToItem<
  T extends { items: readonly { id?: string; children?: readonly { id?: string }[] }[] },
>(turns: readonly T[], upToItemId?: string): T[] {
  if (!upToItemId) return [...turns];
  const turnIdx = turns.findIndex((turn) => turnContainsItem(turn, upToItemId));
  if (turnIdx < 0) return [...turns];
  const targetTurn = turns[turnIdx]!;
  const itemIdx = targetTurn.items.findIndex(
    (item) =>
      item.id === upToItemId ||
      Boolean(item.children?.some((child) => child.id === upToItemId))
  );
  const slicedItems = itemIdx >= 0 ? targetTurn.items.slice(0, itemIdx + 1) : targetTurn.items;
  return [
    ...turns.slice(0, turnIdx),
    {
      ...targetTurn,
      items: slicedItems,
    },
  ];
}

/**
 * Çatallanan konuşma turlarını yeni yan görev sohbetinin üstünde görünecek salt-okunur
 * önek turlarına (`PrefixTranscriptTurn[]`) dönüştürür.
 */
export function buildForkPrefixTurns(turns: readonly VisibleTurnLike[]): PrefixTranscriptTurn[] {
  return turns.map((turn, idx) => {
    const itemPrefix = `fork:i:${idx}`;
    return {
      id: `fork:t:${idx}:${turn.id}`,
      seq: -1_000_000 + idx,
      initiator: turn.initiator ?? 'user',
      items: (turn.items as readonly ChatItem[]).map((item) => rewriteForkItem(item, itemPrefix)),
    };
  });
}

export type ForkToNewTaskOptions = {
  projectId: string;
  taskId: string;
  sourceConversationId: string;
  providerId: AgentProviderId;
  model?: string | undefined;
  autoApprove?: boolean | undefined;
  modeId?: string | undefined;
  effort?: string | undefined;
  upToItemId?: string | undefined;
  fallbackTurns?: readonly VisibleTurnLike[];
};

/**
 * T3 Code'daki gibi aynı projede ve aynı çalışma alanında (yeni worktree klonlamadan)
 * tıklanan yanıta kadarki geçmişi taşıyan ayrı bir yan panel sohbeti/görevi açar ve oraya geçer.
 */
export async function forkConversationToNewTask(
  options: ForkToNewTaskOptions
): Promise<{ taskId: string; conversationId: string }> {
  const manager = conversationRegistry.get(options.taskId);
  if (!manager) throw new Error('Görevin sohbetleri henüz yüklenmedi.');
  const source = manager.conversations.get(options.sourceConversationId)?.data;
  if (!source) throw new Error('Kaynak sohbet bulunamadı.');

  const workspaceId =
    asProvisioned(getTaskStore(options.projectId, options.taskId))?.workspaceId ??
    projectData(getProjectStore(options.projectId))?.repositoryWorkspaceId;
  if (!workspaceId) throw new Error('Çalışma alanı bulunamadı.');

  const taskManager = getTaskManagerStore(options.projectId);
  if (!taskManager) throw new Error('Görev yöneticisi hazır değil.');

  const baseName =
    getRegisteredTaskData(options.projectId, options.taskId)?.name?.trim() ||
    visibleConversationTitle(source.title);
  const nextTaskName = forkTaskTitle(baseName);

  const fallback = options.fallbackTurns ?? [];
  const priorPrefixTurns = fallback.filter(isPrefixTurnLike);
  const currentFallbackTurns = fallback.filter((turn) => !isPrefixTurnLike(turn));

  let combinedTurns: VisibleTurnLike[];
  if (
    options.upToItemId &&
    priorPrefixTurns.some((turn) => turnContainsItem(turn, options.upToItemId!))
  ) {
    combinedTurns = [...priorPrefixTurns, ...currentFallbackTurns];
  } else {
    const client = (await getConversationsClient()).acp;
    let currentSegmentTurns: VisibleTurnLike[];
    try {
      currentSegmentTurns = (await collectHistoryTurns(
        (before) =>
          client.loadHistory({
            conversationId: options.sourceConversationId,
            limit: 100,
            ...(before === undefined ? {} : { before }),
          }) as Promise<HistoryPageResult>,
        currentFallbackTurns
      )) as unknown as VisibleTurnLike[];
      if (currentSegmentTurns.length === 0 && currentFallbackTurns.length > 0) {
        currentSegmentTurns = currentFallbackTurns;
      }
    } catch {
      currentSegmentTurns = currentFallbackTurns;
    }
    combinedTurns = [...priorPrefixTurns, ...currentSegmentTurns];
  }

  const slicedTurns = sliceTurnsUpToItem(combinedTurns, options.upToItemId);
  const summary = buildHandoffSummary({
    turns: slicedTurns,
    sourceTitle: baseName,
  });
  if (!summary.text) throw new Error('Yeni sohbete aktarılacak konuşma geçmişi yok.');

  const prefixTurns = buildForkPrefixTurns(slicedTurns);
  const existingRecord = getHandoffStore().get(options.sourceConversationId);
  const priorChain =
    existingRecord?.chain && existingRecord.chain.length > 0 ? existingRecord.chain : undefined;

  const newTaskId = crypto.randomUUID();
  const newConversationId = crypto.randomUUID();

  setCachedPrefixTurns(newConversationId, prefixTurns);
  getHandoffStore().put(newConversationId, {
    version: 1,
    mode: 'fork',
    sourceConversationId: options.sourceConversationId,
    sourceTitle: baseName,
    ...(options.upToItemId ? { sourceItemId: options.upToItemId } : {}),
    context: summary.text,
    contextDelivered: false,
    createdAt: Date.now(),
    ...(priorChain ? { chain: priorChain } : {}),
    ...(options.effort ? { targetEffort: options.effort } : {}),
  });

  await taskManager.createTask({
    id: newTaskId,
    projectId: options.projectId,
    taskConfig: {
      version: '1',
      name: nextTaskName,
      initialConversation: {
        id: newConversationId,
        provider: options.providerId,
        title: nextDefaultConversationTitle(options.providerId, []),
        type: 'acp',
        ...(options.autoApprove !== undefined ? { autoApprove: options.autoApprove } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.modeId ? { modeId: options.modeId } : {}),
      },
    },
    workspaceConfig: {
      version: '2',
      git: { kind: 'none' },
      workspace: {
        kind: 'repository-instance',
        workspaceId,
      },
    },
  });

  getNavigation().navigate(taskViewDef({ projectId: options.projectId, taskId: newTaskId }));
  return { taskId: newTaskId, conversationId: newConversationId };
}
