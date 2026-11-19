import { eq } from 'drizzle-orm';
import type { AppDb } from '@core/services/app-db/node/db';
import { projects, workspaces } from '@core/services/app-db/node/schema';

/**
 * Projenin depo çalışma alanı yerelse true. Bilinmeyen/silinmiş proje ve SSH projeleri false
 * döner: kancalar uzak makinede komut çalıştırmaz.
 */
export async function isLocalProject(db: AppDb, projectId: string): Promise<boolean> {
  const rows = await db
    .select({
      type: workspaces.type,
      location: workspaces.location,
      sshConnectionId: workspaces.sshConnectionId,
    })
    .from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.repositoryWorkspaceId))
    .where(eq(projects.id, projectId))
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  return row.location !== 'remote' && row.type !== 'project-ssh' && row.sshConnectionId === null;
}
