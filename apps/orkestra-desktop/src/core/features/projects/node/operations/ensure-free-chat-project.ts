import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { ok } from '@orkestra/shared';
import { FREE_CHAT_PROJECT_ID, type CreateProjectResult } from '@core/primitives/projects/api';
import { createProject, type CreateProjectDependencies } from './create-project';
import { getProjectById, getProjectByPath } from './getProjects';

export function freeChatWorkspaceDirectory(): string {
  return join(homedir(), '.local', 'share', 'orkestra', 'free-chats');
}

/**
 * Herhangi bir proje veya git deposu seçilmeden açılan serbest sohbetler için
 * tekil, kalıcı yerel çalışma dizinini ve dahili projeyi garantiler.
 */
export async function ensureFreeChatProject(
  dependencies: CreateProjectDependencies,
  dirOverride?: string
): Promise<CreateProjectResult> {
  const dir = dirOverride ?? freeChatWorkspaceDirectory();
  await mkdir(dir, { recursive: true });

  const existingById = await getProjectById(dependencies.db, FREE_CHAT_PROJECT_ID);
  if (existingById) return ok(existingById);

  const existingByPath = await getProjectByPath(dependencies.db, LOCAL_HOST_REF, dir);
  if (existingByPath) return ok(existingByPath);

  return createProject(dependencies, {
    id: FREE_CHAT_PROJECT_ID,
    type: 'local',
    name: 'Sohbetler',
    path: dir,
    initGitRepository: false,
  });
}
