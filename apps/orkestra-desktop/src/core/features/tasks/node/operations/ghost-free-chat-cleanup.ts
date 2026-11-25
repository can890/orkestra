import { and, eq, isNull, sql } from 'drizzle-orm';
import { isDefaultConversationTitle } from '@core/features/conversations/api/default-conversation-title';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import type { SyncedConversationHost } from '@core/features/conversations/api/node/synced-hosts';
import { workspaceRegistryTable as workspaces } from '@core/features/workspaces/api/node/registry';
import { FREE_CHAT_PROJECT_ID } from '@core/primitives/projects/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { tasks, terminals } from '@core/services/app-db/node/schema';

/**
 * "Hayalet" serbest sohbet temizliği.
 *
 * Ana-makine-önce oluşturma ile otomatik bağlama arasındaki yarış (170d6d08 ile düzeltildi),
 * hiçbir sohbeti olmayan ve sağlayıcı-varsayılan adlı ("Claude (1)", "Antigravity (1)")
 * serbest sohbet görevleri bırakıyordu. Bu modül yalnızca bunları seçer ve mevcut görev silme
 * yolundan geçirerek kaldırır. Seçim kuralı saf ve ayrıntılı test edilmiştir: herhangi bir
 * sohbeti (silinmeyi bekleyen ya da izlenmeyen dahil) veya terminali olan, kullanıcının verdiği
 * bir adı taşıyan, yeni oluşturulmuş, sabitlenmiş, şu an açık olan ya da makinesi bu oturumda
 * henüz eşitlenmemiş görev asla seçilmez.
 */

/** Kalıcı bayrağın sürümü. Kural genişletilirse artırılır; böylece temizlik bir kez daha çalışır. */
export const GHOST_FREE_CHAT_CLEANUP_VERSION = 1;

/** Bu süreden yeni görevler, sohbetleri hâlâ kaydediliyor olabileceği için seçilmez. */
export const GHOST_FREE_CHAT_GRACE_MS = 10 * 60_000;

export type GhostFreeChatCandidate = {
  id: string;
  projectId: string;
  name: string;
  type: string;
  createdAt: string;
  deletedAt: string | null;
  isPinned: boolean;
  /** Görevi gösteren TÜM sohbet satırları (silinme işaretli, izlenmeyen, eksik dahil). */
  conversationCount: number;
  terminalCount: number;
  /** Görevin çalışma alanının makinesi; çalışma alanı yoksa `null`. */
  host: SyncedConversationHost | null;
};

export type GhostFreeChatSelectionContext = {
  now: number;
  graceMs?: number;
  /** Varsayılan başlık tanıma için bilinen sağlayıcı kimlikleri ("claude", "antigravity"…). */
  providerIds: readonly string[];
  openTaskIds: ReadonlySet<string>;
  isHostSynced(host: SyncedConversationHost): boolean;
};

export type GhostFreeChatVerdict =
  | 'ghost'
  | 'not-free-chat'
  | 'deleted'
  | 'not-regular-task'
  | 'pinned'
  | 'has-conversations'
  | 'has-terminals'
  | 'named'
  | 'recent'
  | 'open'
  | 'host-not-synced';

const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/**
 * Görev zaman damgalarını okur: hem ISO (`2026-11-25T08:57:42.393Z`) hem de SQLite
 * `CURRENT_TIMESTAMP` biçimi (`2026-11-25 08:57:42`, UTC) kabul edilir. Okunamazsa `null`.
 */
export function parseTaskTimestamp(value: string): number | null {
  const trimmed = value.trim();
  const normalized = SQLITE_TIMESTAMP.test(trimmed) ? `${trimmed.replace(' ', 'T')}Z` : trimmed;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Tek bir görev için kararın gerekçesi; yalnızca `'ghost'` silinebilir demektir. */
export function classifyGhostFreeChat(
  candidate: GhostFreeChatCandidate,
  context: GhostFreeChatSelectionContext
): GhostFreeChatVerdict {
  if (candidate.projectId !== FREE_CHAT_PROJECT_ID) return 'not-free-chat';
  if (candidate.deletedAt !== null) return 'deleted';
  if (candidate.type !== 'task') return 'not-regular-task';
  if (candidate.isPinned) return 'pinned';
  if (candidate.conversationCount !== 0) return 'has-conversations';
  if (candidate.terminalCount !== 0) return 'has-terminals';
  if (!isDefaultConversationTitle(candidate.name, context.providerIds)) return 'named';
  const createdAt = parseTaskTimestamp(candidate.createdAt);
  const graceMs = context.graceMs ?? GHOST_FREE_CHAT_GRACE_MS;
  if (createdAt === null || context.now - createdAt < graceMs) return 'recent';
  if (context.openTaskIds.has(candidate.id)) return 'open';
  if (!context.isHostSynced(candidate.host ?? { location: 'local', sshConnectionId: null })) {
    return 'host-not-synced';
  }
  return 'ghost';
}

export function selectGhostFreeChatTasks(
  candidates: readonly GhostFreeChatCandidate[],
  context: GhostFreeChatSelectionContext
): GhostFreeChatCandidate[] {
  return candidates.filter((candidate) => classifyGhostFreeChat(candidate, context) === 'ghost');
}

/** "Sohbetler" altındaki silinmemiş görevleri sohbet/terminal sayılarıyla birlikte okur. */
export function loadGhostFreeChatCandidates(db: AppDb, taskId?: string): GhostFreeChatCandidate[] {
  const rows = db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      name: tasks.name,
      type: tasks.type,
      createdAt: tasks.createdAt,
      deletedAt: tasks.deletedAt,
      isPinned: tasks.isPinned,
      conversationCount: sql<number>`(select count(*) from ${conversations} where ${conversations.taskId} = ${tasks.id})`,
      terminalCount: sql<number>`(select count(*) from ${terminals} where ${terminals.taskId} = ${tasks.id})`,
      workspaceLocation: workspaces.location,
      workspaceSshConnectionId: workspaces.sshConnectionId,
    })
    .from(tasks)
    .leftJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
    .where(
      and(
        eq(tasks.projectId, FREE_CHAT_PROJECT_ID),
        isNull(tasks.deletedAt),
        taskId === undefined ? undefined : eq(tasks.id, taskId)
      )
    )
    .all();
  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    type: row.type,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
    isPinned: row.isPinned !== 0,
    conversationCount: Number(row.conversationCount),
    terminalCount: Number(row.terminalCount),
    host:
      row.workspaceLocation === 'local' || row.workspaceLocation === 'remote'
        ? { location: row.workspaceLocation, sshConnectionId: row.workspaceSshConnectionId }
        : null,
  }));
}

/** Görev satırlarında hiç kullanılmış sağlayıcı kimlikleri (özel ACP ajanları dahil). */
export function loadUsedProviderIds(db: AppDb): string[] {
  return db
    .selectDistinct({ provider: conversations.provider })
    .from(conversations)
    .all()
    .map((row) => row.provider)
    .filter((provider): provider is string => !!provider);
}

export type RemovedGhostFreeChat = { id: string; name: string; createdAt: string };

export type GhostFreeChatCleanupResult =
  | { status: 'already-done' }
  | { status: 'deferred'; reason: 'local-sync-pending' | 'registration-pending' }
  | {
      status: 'done';
      removed: RemovedGhostFreeChat[];
      failed: string[];
      /** Kurala uyan ama açık olduğu ya da makinesi eşitlenmediği için bekletilen görevler. */
      held: string[];
      completed: boolean;
    };

export type GhostFreeChatCleanupDependencies = {
  db: AppDb;
  /** Mevcut görev silme yolu (oturum kapatma, sohbet basamaklaması, memento temizliği). */
  deleteTask(projectId: string, taskId: string): Promise<void>;
  readCompletedVersion(): Promise<number | null>;
  writeCompletedVersion(version: number): Promise<void>;
  builtInProviderIds(): readonly string[];
  waitForLocalSync(): Promise<boolean>;
  hasPendingRegistrations(): boolean;
  isHostSynced(host: SyncedConversationHost): boolean;
  logger: {
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
  };
  now?: () => number;
};

/**
 * Temizliği bir kez çalıştırır. Kalıcı bayrak yalnızca hiçbir silme başarısız olmadığında ve
 * kurala uyup bekletilen görev kalmadığında yazılır; aksi halde bir sonraki açılışta tekrar
 * denenir (iş idempotenttir: silinmiş görev bir daha seçilemez).
 */
export async function runGhostFreeChatCleanup(
  dependencies: GhostFreeChatCleanupDependencies,
  input: { openTaskIds: readonly string[] }
): Promise<GhostFreeChatCleanupResult> {
  const { db, logger } = dependencies;
  const completed = await dependencies.readCompletedVersion();
  if (completed !== null && completed >= GHOST_FREE_CHAT_CLEANUP_VERSION) {
    return { status: 'already-done' };
  }
  if (!(await dependencies.waitForLocalSync())) {
    return { status: 'deferred', reason: 'local-sync-pending' };
  }
  if (dependencies.hasPendingRegistrations()) {
    return { status: 'deferred', reason: 'registration-pending' };
  }

  const now = dependencies.now ?? Date.now;
  const context: GhostFreeChatSelectionContext = {
    now: now(),
    providerIds: [...new Set([...dependencies.builtInProviderIds(), ...loadUsedProviderIds(db)])],
    openTaskIds: new Set(input.openTaskIds),
    isHostSynced: dependencies.isHostSynced,
  };

  const removed: RemovedGhostFreeChat[] = [];
  const failed: string[] = [];
  const held: string[] = [];
  for (const candidate of loadGhostFreeChatCandidates(db)) {
    const verdict = classifyGhostFreeChat(candidate, context);
    if (verdict === 'open' || verdict === 'host-not-synced') {
      held.push(candidate.id);
      continue;
    }
    if (verdict !== 'ghost') continue;
    // Seçim ile silme arasında bir sohbet bağlanmış olabilir: silmeden hemen önce yeniden doğrula.
    const [fresh] = loadGhostFreeChatCandidates(db, candidate.id);
    if (!fresh || classifyGhostFreeChat(fresh, { ...context, now: now() }) !== 'ghost') continue;
    try {
      await dependencies.deleteTask(fresh.projectId, fresh.id);
      removed.push({ id: fresh.id, name: fresh.name, createdAt: fresh.createdAt });
    } catch (error) {
      failed.push(fresh.id);
      logger.warn('Ghost free chat could not be removed', {
        taskId: fresh.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const isComplete = failed.length === 0 && held.length === 0;
  if (isComplete) await dependencies.writeCompletedVersion(GHOST_FREE_CHAT_CLEANUP_VERSION);
  logger.info('Ghost free chat cleanup finished', {
    removed: removed.map((task) => ({ id: task.id, name: task.name, createdAt: task.createdAt })),
    failed,
    held,
    completed: isComplete,
  });
  return { status: 'done', removed, failed, held, completed: isComplete };
}
