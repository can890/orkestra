import { join } from 'node:path';
import type { TranscriptTurn } from '@orkestra/core/runtimes/acp/api/client';
import type { Logger } from '@orkestra/shared/logger';
import { and, eq } from 'drizzle-orm';
import type { AtlasSettings } from '@core/features/atlas/api/atlas-model';
import {
  conversationRegistryTable as conversations,
  liveConversations,
} from '@core/features/conversations/api/node/registry';
import type { AppDb } from '@core/services/app-db/node/db';
import { projects, tasks } from '@core/services/app-db/node/schema';
import type { NotificationService } from '@core/services/notifications/node';
import { AtlasCli, atlasSearchPath, nodeAtlasRunner, resolveAtlasExecutable } from './atlas-cli';
import { AtlasService, type AtlasConversationInfo } from './atlas-service';
import { AtlasStateStore } from './atlas-state-store';

export type DesktopAtlasDeps = {
  db: AppDb;
  userDataDirectory: string;
  settings(): Promise<AtlasSettings>;
  /** Kullanıcının kabuk ortamı (PATH vb.); yoksa süreç ortamı. */
  baseEnv(): NodeJS.ProcessEnv;
  /** Sohbetin bilinen en hızlı transkripti (önbellek / yerel günlük). */
  readTranscript(conversationId: string): Promise<readonly TranscriptTurn[]>;
  generateText(input: { systemPrompt: string; prompt: string }): Promise<string | null>;
  notifications: Pick<NotificationService, 'publish'>;
  logger: Logger;
};

function toInfo(row: typeof conversations.$inferSelect): AtlasConversationInfo {
  return {
    id: row.id,
    projectId: row.projectId ?? null,
    taskId: row.taskId ?? null,
    title: row.title || null,
    workspacePath: row.workspacePath ?? row.cwd ?? null,
  };
}

/** Atlas servisini masaüstü veritabanı, transkript önbelleği ve bildirimlerle kurar. */
export function createDesktopAtlasService(deps: DesktopAtlasDeps): AtlasService {
  const env = (): NodeJS.ProcessEnv => {
    const base = deps.baseEnv();
    return { ...base, PATH: atlasSearchPath(base).join(':') };
  };
  const cli = new AtlasCli({
    runner: nodeAtlasRunner,
    env,
    resolveExecutable: async () =>
      resolveAtlasExecutable({ configured: (await deps.settings()).executable, env: env() }),
  });
  return new AtlasService({
    settings: deps.settings,
    cli,
    store: new AtlasStateStore(join(deps.userDataDirectory, 'atlas', 'state.json')),
    conversation: async (conversationId) => {
      const [row] = deps.db
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), liveConversations()))
        .limit(1)
        .all();
      return row ? toInfo(row) : null;
    },
    conversationsForTask: async (taskId) =>
      deps.db
        .select()
        .from(conversations)
        .where(and(eq(conversations.taskId, taskId), liveConversations()))
        .all()
        .map(toInfo),
    projectName: async (projectId) => {
      const [row] = deps.db
        .select({ name: projects.name })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1)
        .all();
      return row?.name ?? null;
    },
    task: async (taskId) => {
      const [row] = deps.db
        .select({ name: tasks.name, branch: tasks.taskBranch })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
        .all();
      return row ? { name: row.name, branch: row.branch ?? null } : null;
    },
    transcript: deps.readTranscript,
    generateText: deps.generateText,
    notify: (record) => {
      const firstLine = record.text.split('\n')[0] ?? record.title;
      deps.notifications.publish({
        kind: 'atlas-card',
        groupKey: `atlas-card:${record.conversationId}`,
        dedupeKey: `atlas-card:${record.conversationId}`,
        title: 'Atlas card written',
        body: `${firstLine} — tags: ${record.tags.join(', ')}`,
        sound: null,
        target:
          record.projectId && record.taskId
            ? {
                kind: 'task',
                projectId: record.projectId,
                taskId: record.taskId,
                conversationId: record.conversationId,
              }
            : { kind: 'none' },
        source: { kind: 'app' },
      });
    },
    logger: deps.logger,
  });
}
