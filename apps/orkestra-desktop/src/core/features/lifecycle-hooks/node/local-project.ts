import { and, eq } from 'drizzle-orm';
import {
  liveWorkspaces,
  workspaceRegistryTable as workspaces,
} from '@core/features/workspaces/api/node/registry';
import type { AppDb } from '@core/services/app-db/node/db';
import { projects } from '@core/services/app-db/node/schema';

/**
 * Projenin depo çalışma alanı yerelse true. Bilinmeyen/silinmiş proje, konumu belirsiz
 * çalışma alanı ve SSH projeleri false döner: kancalar uzak makinede komut çalıştırmaz.
 */
export async function isLocalProject(db: AppDb, projectId: string): Promise<boolean> {
  const rows = await db
    .select({ location: workspaces.location, sshConnectionId: workspaces.sshConnectionId })
    .from(projects)
    .innerJoin(workspaces, eq(projects.repositoryWorkspaceId, workspaces.id))
    .where(and(eq(projects.id, projectId), liveWorkspaces()))
    .limit(1);
  const row = rows[0];
  return row !== undefined && row.location === 'local' && row.sshConnectionId === null;
}
