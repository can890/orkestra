import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import {
  liveWorkspaces,
  workspaceRegistryTable as workspaces,
} from '@core/features/workspaces/api/node/registry';
import type { AppDb } from '@core/services/app-db/node/db';
import { projects, tasks } from '@core/services/app-db/node/schema';

/** Bir worktree'yi kullanan görev (yalnızca temizlik kararının ihtiyaç duyduğu alanlar). */
export type CandidateTask = {
  id: string;
  name: string;
  status: string;
  pinned: boolean;
  /** Arşivlenme zamanı (ms); arşivli değilse null. */
  archivedAt: number | null;
  /** Mevcut duruma geçiş zamanı (ms). */
  statusChangedAt: number | null;
  /** Görev veya sohbetlerindeki son etkinlik (ms). */
  activityAt: number;
  /** Sohbetlerinden biri şu an çalışıyor ya da girdi bekliyor mu. */
  agentBusy: boolean;
};

/** Orkestra'nın oluşturduğu, yerel bir görev worktree'si. */
export type WorktreeCandidate = {
  workspaceId: string;
  path: string;
  projectId: string;
  projectName: string;
  /** Projenin depo kökü (ana checkout); bilinmiyorsa null. */
  repositoryPath: string | null;
  /** Worktree'nin dalı (workspace yapılandırmasından ya da gözlemden). */
  branch: string | null;
  /** Son etkinleştirilme (açılma) zamanı (ms). */
  lastActivatedAt: number | null;
  tasks: CandidateTask[];
};

const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/u;

/** SQLite `CURRENT_TIMESTAMP` (UTC, boşluklu) ya da ISO metnini ms'ye çevirir. */
export function parseDbTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = SQLITE_TIMESTAMP.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

const BUSY_AGENT_STATUSES = new Set(['working', 'awaiting-input']);
const SETTLED_STATUSES = new Set(['done', 'cancelled', 'duplicate']);

/** Görev durulmuş mu (bitti/iptal/kopya) ya da arşivli mi; ne zamandan beri (ms). */
export function settledSince(task: CandidateTask): number | null {
  if (task.archivedAt !== null) return task.archivedAt;
  if (SETTLED_STATUSES.has(task.status)) return task.statusChangedAt;
  return null;
}

/**
 * Temizlik adaylarını uygulama veritabanından okur: yalnızca Orkestra'nın oluşturduğu
 * (`config` dolu), yerel, kaydı canlı ve diskte mevcut gözlenen görev worktree'leri.
 * Benimsenen (adopted) worktree'ler, dizin/depo workspace'leri ve SSH worktree'leri
 * hiç aday olmaz.
 */
export async function loadWorktreeCandidates(db: AppDb): Promise<WorktreeCandidate[]> {
  const rows = await db
    .select({
      workspaceId: workspaces.id,
      path: workspaces.path,
      config: workspaces.config,
      observedGit: workspaces.observedGit,
      observedStatus: workspaces.observedStatus,
      lastActivatedAt: workspaces.lastActivatedAt,
      deletionTombstone: workspaces.deletionTombstone,
      taskId: tasks.id,
      taskName: tasks.name,
      taskStatus: tasks.status,
      taskPinned: tasks.isPinned,
      taskArchivedAt: tasks.archivedAt,
      taskStatusChangedAt: tasks.statusChangedAt,
      taskCreatedAt: tasks.createdAt,
      taskLastInteractedAt: tasks.lastInteractedAt,
      projectId: projects.id,
      projectName: projects.name,
      repositoryWorkspaceId: projects.repositoryWorkspaceId,
    })
    .from(workspaces)
    .innerJoin(tasks, eq(tasks.workspaceId, workspaces.id))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(
      and(
        liveWorkspaces(),
        eq(workspaces.kind, 'worktree'),
        eq(workspaces.location, 'local'),
        isNotNull(workspaces.path),
        isNull(tasks.deletedAt),
        isNull(projects.deletedAt)
      )
    );

  const taskIds = rows.map((row) => row.taskId);
  const conversationRows =
    taskIds.length === 0
      ? []
      : await db
          .select({
            taskId: conversations.taskId,
            agentStatus: conversations.agentStatus,
            updatedAt: conversations.updatedAt,
            lastSessionActivityAt: conversations.lastSessionActivityAt,
          })
          .from(conversations)
          .where(and(inArray(conversations.taskId, taskIds), isNull(conversations.untrackedAt)));
  const conversationActivity = new Map<string, { at: number; busy: boolean }>();
  for (const row of conversationRows) {
    if (!row.taskId) continue;
    const current = conversationActivity.get(row.taskId) ?? { at: 0, busy: false };
    const at = Math.max(
      parseDbTime(row.updatedAt) ?? 0,
      parseDbTime(row.lastSessionActivityAt) ?? 0
    );
    conversationActivity.set(row.taskId, {
      at: Math.max(current.at, at),
      busy: current.busy || BUSY_AGENT_STATUSES.has(row.agentStatus ?? ''),
    });
  }

  const repositoryIds = [
    ...new Set(rows.map((row) => row.repositoryWorkspaceId).filter((id): id is string => !!id)),
  ];
  const repositoryPaths = new Map<string, string>();
  if (repositoryIds.length > 0) {
    const repositoryRows = await db
      .select({ id: workspaces.id, path: workspaces.path })
      .from(workspaces)
      .where(inArray(workspaces.id, repositoryIds));
    for (const row of repositoryRows) if (row.path) repositoryPaths.set(row.id, row.path);
  }

  const byWorkspace = new Map<string, WorktreeCandidate>();
  for (const row of rows) {
    // Benimsenmiş (Orkestra'nın oluşturmadığı) ya da silinmekte olan worktree'lere dokunulmaz.
    if (row.config === null || row.deletionTombstone !== null) continue;
    if (row.observedStatus === 'missing' || !row.path) continue;
    let candidate = byWorkspace.get(row.workspaceId);
    if (!candidate) {
      const git = row.config.git;
      const configuredBranch =
        git.kind === 'create-branch' || git.kind === 'use-branch' ? git.branchName : null;
      candidate = {
        workspaceId: row.workspaceId,
        path: row.path,
        projectId: row.projectId,
        projectName: row.projectName,
        repositoryPath: row.repositoryWorkspaceId
          ? (repositoryPaths.get(row.repositoryWorkspaceId) ?? null)
          : null,
        branch: configuredBranch ?? row.observedGit?.branch ?? null,
        lastActivatedAt: row.lastActivatedAt ?? null,
        tasks: [],
      };
      byWorkspace.set(row.workspaceId, candidate);
    }
    const conversation = conversationActivity.get(row.taskId);
    candidate.tasks.push({
      id: row.taskId,
      name: row.taskName,
      status: row.taskStatus,
      pinned: row.taskPinned === 1,
      archivedAt: parseDbTime(row.taskArchivedAt),
      statusChangedAt: parseDbTime(row.taskStatusChangedAt),
      activityAt: Math.max(
        parseDbTime(row.taskCreatedAt) ?? 0,
        parseDbTime(row.taskLastInteractedAt) ?? 0,
        conversation?.at ?? 0
      ),
      agentBusy: conversation?.busy ?? false,
    });
  }
  return [...byWorkspace.values()];
}
