// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src/components/settings/ProjectRepositoriesSettings.tsx
import { Button } from '@orkestra/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { GitBranch, RotateCw } from 'lucide-react';
import { getProjectRepositoriesClient } from '@core/features/project-repositories/api/browser/client';

/**
 * Proje ayarlarındaki salt okunur "Repositories" bölümü: projenin kapsadığı depoları (yol, dal,
 * uzak depo) diskten okuyarak listeler. Liste saklanmaz; klasöre klonlanan bir depo bir sonraki
 * okumada görünür. Projede iç depo yoksa (sıradan tek depolu proje) bölüm hiç çizilmez.
 */
export function ProjectRepositoriesPanel({ projectId }: { projectId: string }) {
  const query = useQuery({
    queryKey: ['projectRepositories', 'settings', projectId],
    queryFn: async () => (await getProjectRepositoriesClient()).listRepositories({ projectId }),
    refetchOnWindowFocus: true,
  });
  const data = query.data;
  if (!data || data.status !== 'ok' || data.repositories.length === 0) return null;

  return (
    <section
      aria-label="Repositories"
      className="mt-8 flex flex-col gap-3 border-t border-border pt-6"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Repositories</h3>
          <p className="text-xs leading-relaxed text-foreground-muted">
            Repositories this project covers, read from disk: folders one level down, and one more
            level inside folders that are not repositories themselves. Worktrees of another
            repository are left out. Git actions run in one repository at a time.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Refresh repositories"
          title="Refresh repositories"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RotateCw className="size-3.5" />
        </Button>
      </div>
      <ul className="flex flex-col gap-1">
        {data.repositories.map((repository) => {
          const remote =
            repository.remotes.find((candidate) => candidate.name === 'origin') ??
            repository.remotes[0];
          return (
            <li
              key={repository.relativePath}
              className="flex flex-col gap-0.5 rounded-md border border-border bg-background-1 px-2.5 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="truncate font-mono text-sm" title={repository.path}>
                  {repository.relativePath}
                </span>
                {repository.kind === 'submodule' && (
                  <span className="text-xs text-foreground-muted">submodule</span>
                )}
                <span className="flex-1" />
                <span className="flex items-center gap-1 text-xs text-foreground-muted">
                  <GitBranch className="size-3" />
                  {repository.branch ?? repository.detachedAt ?? 'unknown'}
                </span>
              </div>
              <span className="truncate text-xs text-foreground-muted" title={remote?.url}>
                {remote ? `${remote.name}: ${remote.url}` : 'No remote'}
              </span>
            </li>
          );
        })}
      </ul>
      {data.truncated && (
        <p className="text-xs text-foreground-muted">Only the first 128 repositories are shown.</p>
      )}
    </section>
  );
}
