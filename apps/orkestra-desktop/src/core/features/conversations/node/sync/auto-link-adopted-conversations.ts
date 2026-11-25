import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull, or } from 'drizzle-orm';
import { conversationWireEvents } from '@core/features/conversations/api/node';
import {
  conversationRegistryTable as conversations,
  liveConversations,
} from '@core/features/conversations/api/node/registry';
import { mapConversationRowToConversation } from '@core/features/conversations/api/node/utils';
import { workspaceRegistryTable as workspaces } from '@core/features/workspaces/api/node/registry';
import { FREE_CHAT_PROJECT_ID } from '@core/primitives/projects/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { appDbPokes } from '@core/services/app-db/node/pokes';
import { projects, tasks } from '@core/services/app-db/node/schema';
import type { ConversationHostIdentity } from './apply-conversation-snapshot';

const PLACEHOLDER_TASK_TITLES = new Set(['Yeni sohbet', 'Yeni görev', 'New chat', 'New task']);

export type AutoLinkAdoptedResult = {
  linked: number;
  titlesSynced: number;
};

export type AutoLinkAdoptedOptions = {
  /**
   * Hedef dizin için uzak/yerel makinenin `workspaceRegistry` kayıt defterinden kanonik
   * çalışma alanı kimliğini (varsa mevcut, yoksa yeni kayıt) çözümler. Böylece asla
   * host kayıt defterinin tanımadığı sahte bir workspace kimliği üretilmez.
   */
  resolveHostWorkspaceId?: (path: string) => Promise<string | null>;
};

function normalizePosixPath(value: string | null | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed === '/') return '/';
  return trimmed.replace(/\/+$/, '');
}

function isSameOrChildPath(candidate: string, base: string): boolean {
  if (!candidate || !base) return false;
  if (candidate === base) return true;
  return candidate.startsWith(`${base}/`);
}

function ensureLocalFreeChatProject(db: AppDb, now: string): string {
  const [existing] = db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, FREE_CHAT_PROJECT_ID), isNull(projects.deletedAt)))
    .limit(1)
    .all();
  if (existing) return existing.id;

  const freeDir = join(homedir(), '.local', 'share', 'orkestra', 'free-chats');
  try {
    mkdirSync(freeDir, { recursive: true });
  } catch {
    // Dizin oluşturulamasa da veritabanı satırı eklenebilir.
  }

  let repoWorkspaceId: string | null = null;
  const [existingWs] = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.location, 'local'),
        isNull(workspaces.sshConnectionId),
        eq(workspaces.path, freeDir),
        isNull(workspaces.untrackedAt)
      )
    )
    .limit(1)
    .all();
  if (existingWs) {
    repoWorkspaceId = existingWs.id;
  } else {
    repoWorkspaceId = randomUUID();
    db.insert(workspaces)
      .values({
        id: repoWorkspaceId,
        type: 'local',
        kind: 'directory',
        location: 'local',
        sshConnectionId: null,
        path: freeDir,
        origin: 'registered',
        observedStatus: 'present',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  }

  db.insert(projects)
    .values({
      id: FREE_CHAT_PROJECT_ID,
      name: 'Sohbetler',
      repositoryWorkspaceId: repoWorkspaceId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();

  appDbPokes.projects.poke({});
  return FREE_CHAT_PROJECT_ID;
}

async function ensureHostWorkspace(
  db: AppDb,
  host: ConversationHostIdentity,
  targetPath: string,
  now: string,
  resolveHostWorkspaceId?: (path: string) => Promise<string | null>
): Promise<string> {
  const hostPredicate =
    host.sshConnectionId === null
      ? isNull(workspaces.sshConnectionId)
      : eq(workspaces.sshConnectionId, host.sshConnectionId);

  const [existing] = db
    .select({ id: workspaces.id, observedStatus: workspaces.observedStatus })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.location, host.location),
        hostPredicate,
        eq(workspaces.path, targetPath),
        isNull(workspaces.untrackedAt)
      )
    )
    .limit(1)
    .all();
  if (existing && existing.observedStatus !== 'missing') return existing.id;

  const canonicalId = (await resolveHostWorkspaceId?.(targetPath).catch(() => null)) ?? null;
  if (existing && (!canonicalId || canonicalId === existing.id)) {
    return existing.id;
  }

  const id = canonicalId ?? randomUUID();
  if (existing && canonicalId && canonicalId !== existing.id) {
    // Önceki eksik/sahte workspace satırını host'un gerçek kanonik kimliğiyle değiştir.
    db.update(tasks)
      .set({ workspaceId: canonicalId })
      .where(eq(tasks.workspaceId, existing.id))
      .run();
    db.delete(workspaces).where(eq(workspaces.id, existing.id)).run();
  }

  db.insert(workspaces)
    .values({
      id,
      type: host.location === 'remote' ? 'project-ssh' : 'local',
      kind: 'directory',
      location: host.location,
      sshConnectionId: host.sshConnectionId,
      path: targetPath,
      origin: 'adopted',
      observedStatus: 'present',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();

  const [resolved] = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.location, host.location),
        hostPredicate,
        eq(workspaces.path, targetPath),
        isNull(workspaces.untrackedAt)
      )
    )
    .limit(1)
    .all();
  return resolved?.id ?? id;
}

/**
 * Bir makineden (ör. Huawei `workspace-server`) canlı senkronla `adopted` olarak gelen ve
 * henüz bir proje/göreve bağlanmamış konuşmaları otomatik olarak eşleşen projeye (ya da
 * `Sohbetler` altına) bağlar. Böylece mobilden veya başka bir istemciden başlatılan tüm
 * görevler Mac masaüstünde ve mobilde anlık olarak görünür ve canlı izlenebilir.
 */
export async function autoLinkAdoptedConversations(
  db: AppDb,
  host: ConversationHostIdentity,
  options: AutoLinkAdoptedOptions = {}
): Promise<AutoLinkAdoptedResult> {
  const now = new Date().toISOString();
  const hostPredicate =
    host.sshConnectionId === null
      ? isNull(conversations.sshConnectionId)
      : eq(conversations.sshConnectionId, host.sshConnectionId);

  const unlinked = db
    .select()
    .from(conversations)
    .where(
      and(
        liveConversations(),
        eq(conversations.location, host.location),
        hostPredicate,
        or(isNull(conversations.projectId), isNull(conversations.taskId))
      )
    )
    .all();

  let linked = 0;
  let titlesSynced = 0;

  if (unlinked.length > 0) {
    const wsHostPredicate =
      host.sshConnectionId === null
        ? isNull(workspaces.sshConnectionId)
        : eq(workspaces.sshConnectionId, host.sshConnectionId);

    const hostWorkspaces = db
      .select({
        id: workspaces.id,
        path: workspaces.path,
        parentId: workspaces.parentId,
      })
      .from(workspaces)
      .where(
        and(eq(workspaces.location, host.location), wsHostPredicate, isNull(workspaces.untrackedAt))
      )
      .all();

    const activeProjects = db
      .select({
        id: projects.id,
        repositoryWorkspaceId: projects.repositoryWorkspaceId,
      })
      .from(projects)
      .where(isNull(projects.deletedAt))
      .all();

    const projectByRepoWorkspaceId = new Map<string, string>();
    for (const project of activeProjects) {
      if (project.repositoryWorkspaceId) {
        projectByRepoWorkspaceId.set(project.repositoryWorkspaceId, project.id);
      }
    }

    for (const row of unlinked) {
      const convPath = normalizePosixPath(row.workspacePath ?? row.cwd);
      if (!convPath) continue;

      // En spesifik (en uzun yol) eşleşen proje çalışma alanını bul.
      let matchedProjectId: string | null = null;
      let matchedWorkspaceId: string | null = null;
      let bestMatchLen = -1;

      for (const ws of hostWorkspaces) {
        const wsPath = normalizePosixPath(ws.path);
        if (!wsPath || !isSameOrChildPath(convPath, wsPath)) continue;
        const projId =
          projectByRepoWorkspaceId.get(ws.id) ??
          (ws.parentId ? projectByRepoWorkspaceId.get(ws.parentId) : undefined);
        if (!projId) continue;
        if (wsPath.length > bestMatchLen) {
          bestMatchLen = wsPath.length;
          matchedProjectId = projId;
          matchedWorkspaceId = ws.id;
        }
      }

      const projectId = matchedProjectId ?? ensureLocalFreeChatProject(db, now);
      const workspaceId =
        matchedWorkspaceId ??
        (await ensureHostWorkspace(db, host, convPath, now, options.resolveHostWorkspaceId));
      const taskId = randomUUID();
      const taskName = row.title?.trim() || 'Yeni sohbet';

      db.insert(tasks)
        .values({
          id: taskId,
          projectId,
          name: taskName,
          status: 'in-progress',
          workspaceId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          lastInteractedAt: row.lastSessionActivityAt ?? row.updatedAt,
          statusChangedAt: row.updatedAt,
          type: 'task',
        })
        .run();

      db.update(conversations)
        .set({
          projectId,
          taskId,
          isInitialConversation: true,
          updatedAt: row.updatedAt,
        })
        .where(eq(conversations.id, row.id))
        .run();

      const [updatedRow] = db
        .select()
        .from(conversations)
        .where(eq(conversations.id, row.id))
        .limit(1)
        .all();
      const dto = updatedRow ? mapConversationRowToConversation(updatedRow) : null;
      if (dto) {
        conversationWireEvents.emit(undefined, { type: 'created', conversation: dto });
      }
      appDbPokes.workspaces.poke({ projectId });
      appDbPokes.tasks.poke({ projectId, taskId });
      appDbPokes.conversations.poke({ projectId, taskId });
      linked += 1;
    }
  }

  // Başlığı sonradan güncellenen uzak konuşmaların yer tutucu görev adlarını da eşitle.
  const linkedRows = db
    .select({
      convTitle: conversations.title,
      convUpdatedAt: conversations.updatedAt,
      taskId: conversations.taskId,
      projectId: conversations.projectId,
      taskName: tasks.name,
    })
    .from(conversations)
    .innerJoin(tasks, eq(tasks.id, conversations.taskId))
    .where(
      and(
        liveConversations(),
        eq(conversations.location, host.location),
        hostPredicate,
        eq(conversations.isInitialConversation, true)
      )
    )
    .all();

  for (const item of linkedRows) {
    if (!item.taskId || !item.projectId) continue;
    const nextTitle = item.convTitle?.trim();
    if (!nextTitle || PLACEHOLDER_TASK_TITLES.has(nextTitle)) continue;
    if (!PLACEHOLDER_TASK_TITLES.has(item.taskName)) continue;
    if (nextTitle === item.taskName) continue;

    db.update(tasks)
      .set({ name: nextTitle, updatedAt: item.convUpdatedAt })
      .where(eq(tasks.id, item.taskId))
      .run();
    appDbPokes.tasks.poke({ projectId: item.projectId, taskId: item.taskId });
    titlesSynced += 1;
  }

  return { linked, titlesSynced };
}
