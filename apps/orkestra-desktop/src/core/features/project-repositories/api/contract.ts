import { defineContract, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

export const projectRepositoriesDomain = 'projectRepositories' as const;

const remoteSchema = z.object({ name: z.string(), url: z.string() });

export const projectRepositoryInfoSchema = z.object({
  /** Proje (ya da görev) klasörüne göre `/` ayraçlı göreli yol. */
  relativePath: z.string(),
  /** Host üzerindeki mutlak yol. */
  path: z.string(),
  name: z.string(),
  kind: z.enum(['repository', 'submodule']),
  branch: z.string().nullable(),
  detachedAt: z.string().nullable(),
  remotes: z.array(remoteSchema),
});
export type ProjectRepositoryInfo = z.infer<typeof projectRepositoryInfoSchema>;

const unsupportedSchema = z.object({
  status: z.literal('unsupported'),
  reason: z.enum(['remote-host', 'not-found']),
});

export const listProjectRepositoriesResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    root: z.string(),
    rootIsRepository: z.boolean(),
    repositories: z.array(projectRepositoryInfoSchema),
    truncated: z.boolean(),
  }),
  unsupportedSchema,
]);
export type ListProjectRepositoriesResult = z.infer<typeof listProjectRepositoriesResultSchema>;

export const repositoryChangedFileSchema = z.object({
  /** Görev klasörüne göre yol: deponun göreli klasörüyle önekli (ör. `api/src/index.ts`). */
  path: z.string(),
  /** Depo köküne göre yol. */
  repositoryPath: z.string(),
  index: z.string(),
  worktree: z.string(),
});
export type RepositoryChangedFile = z.infer<typeof repositoryChangedFileSchema>;

export const repositoryChangesSchema = z.object({
  relativePath: z.string(),
  name: z.string(),
  kind: z.enum(['repository', 'submodule']),
  branch: z.string().nullable(),
  files: z.array(repositoryChangedFileSchema),
  tooManyFiles: z.boolean(),
  error: z.string().nullable(),
});
export type RepositoryChanges = z.infer<typeof repositoryChangesSchema>;

export const listRepositoryChangesResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), repositories: z.array(repositoryChangesSchema) }),
  unsupportedSchema,
]);
export type ListRepositoryChangesResult = z.infer<typeof listRepositoryChangesResultSchema>;

export const discoverFolderResultSchema = z.object({
  rootIsRepository: z.boolean(),
  repositories: z.array(
    z.object({
      relativePath: z.string(),
      name: z.string(),
      kind: z.enum(['repository', 'submodule']),
    })
  ),
  truncated: z.boolean(),
});
export type DiscoverFolderResult = z.infer<typeof discoverFolderResultSchema>;

/**
 * Çok depolu projeler: proje (ya da görev) klasörünün kapsadığı depoları diskten keşfeder ve
 * tüm depoların değişen dosyalarını tek listede verir. Depo başına status/diff/stage/commit/push
 * işlemleri kaynak kontrolü sözleşmesinden bileşik çalışma alanı kimliğiyle yapılır
 * (`nested-repository-id.ts`).
 */
export const projectRepositoriesContract = defineContract({
  listRepositories: procedure({
    input: z.object({ projectId: z.string().min(1), workspaceId: z.string().min(1).optional() }),
    output: listProjectRepositoriesResultSchema,
  }),
  /** Proje eklenmeden önce yerel bir klasörün kapsayacağı depolar (yalnızca yerel host). */
  discoverLocalFolder: procedure({
    input: z.object({ path: z.string().min(1) }),
    output: discoverFolderResultSchema,
  }),
  listChanges: procedure({
    input: z.object({ workspaceId: z.string().min(1) }),
    output: listRepositoryChangesResultSchema,
  }),
});

export type ProjectRepositoriesContract = typeof projectRepositoriesContract;
