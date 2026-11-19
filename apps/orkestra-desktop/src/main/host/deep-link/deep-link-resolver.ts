import { and, eq } from 'drizzle-orm';
import {
  conversationRegistryTable as conversations,
  liveConversations,
} from '@core/features/conversations/api/node/registry';
import type { DeepLinkRoute, DeepLinkTarget } from '@core/primitives/deep-links/api/deep-link';
import type { AppDb } from '@core/services/app-db/node/db';
import { projects, tasks } from '@core/services/app-db/node/schema';

/**
 * Kimliği yalnızca OKUYARAK gezinme hedefine çevirir (salt okunur seçimler).
 * Veritabanında olmayan kimlik `not-found` olur.
 */
export function createDeepLinkResolver(db: AppDb) {
  return async (route: DeepLinkRoute): Promise<DeepLinkTarget> => {
    switch (route.kind) {
      case 'project': {
        const [row] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, route.id))
          .limit(1);
        return row ? { kind: 'project', projectId: row.id } : { kind: 'not-found', route };
      }
      case 'task': {
        const [row] = await db
          .select({ id: tasks.id, projectId: tasks.projectId })
          .from(tasks)
          .where(eq(tasks.id, route.id))
          .limit(1);
        return row
          ? { kind: 'task', projectId: row.projectId, taskId: row.id }
          : { kind: 'not-found', route };
      }
      case 'conversation': {
        const [row] = await db
          .select({
            id: conversations.id,
            projectId: conversations.projectId,
            taskId: conversations.taskId,
          })
          .from(conversations)
          .where(and(liveConversations(), eq(conversations.id, route.id)))
          .limit(1);
        if (!row || row.projectId === null || row.taskId === null) {
          return { kind: 'not-found', route };
        }
        return {
          kind: 'conversation',
          projectId: row.projectId,
          taskId: row.taskId,
          conversationId: row.id,
        };
      }
    }
  };
}
