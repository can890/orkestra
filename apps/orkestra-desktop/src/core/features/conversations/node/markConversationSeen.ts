import { eq } from 'drizzle-orm';
import { conversationRegistryTable } from '@core/features/conversations/api/node/registry';
import type { AppDb } from '@core/services/app-db/node/db';
import { conversationWireEvents } from './event-host';

/** Seen-state is a device-local client annotation (spec §3.2) — never a host fact. */
export async function markConversationSeen(db: AppDb, conversationId: string): Promise<void> {
  const row = db
    .update(conversationRegistryTable)
    .set({ agentStatusSeen: 1 })
    .where(eq(conversationRegistryTable.id, conversationId))
    .returning({
      projectId: conversationRegistryTable.projectId,
      taskId: conversationRegistryTable.taskId,
    })
    .get();
  if (row?.projectId && row.taskId) {
    conversationWireEvents.emit(undefined, {
      type: 'seen',
      conversationId,
      projectId: row.projectId,
      taskId: row.taskId,
    });
  }
}
