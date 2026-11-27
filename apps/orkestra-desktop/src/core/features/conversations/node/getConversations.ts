import { and, eq, isNull } from 'drizzle-orm';
import {
  conversationRegistryTable as conversations,
  liveConversations,
} from '@core/features/conversations/api/node/registry';
import { mapConversationRowsToConversations } from '@core/features/conversations/api/node/utils';
import type { AppDb } from '@core/services/app-db/node/db';
import { tasks } from '@core/services/app-db/node/schema';

export async function getConversations(db: AppDb) {
  const rows = await db
    .select({ conversation: conversations, taskName: tasks.name })
    .from(conversations)
    .innerJoin(tasks, eq(conversations.taskId, tasks.id))
    .where(and(isNull(tasks.archivedAt), isNull(tasks.deletedAt), liveConversations()));
  const mapped = mapConversationRowsToConversations(rows.map(({ conversation }) => conversation));
  return mapped.map((conv, index) => {
    const taskName = rows[index]?.taskName?.trim();
    return taskName ? { ...conv, taskName } : conv;
  });
}
