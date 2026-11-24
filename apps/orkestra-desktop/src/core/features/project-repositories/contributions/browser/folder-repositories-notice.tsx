import { useQuery } from '@tanstack/react-query';
import { FolderGit2 } from 'lucide-react';
import { getProjectRepositoriesClient } from '@core/features/project-repositories/api/browser/client';

const PREVIEW_LIMIT = 6;

/**
 * Proje ekleme penceresinde, Git deposu olmayan bir yerel klasör seçildiğinde klasörün içerdiği
 * depoları gösterir: böyle bir klasör çok depolu proje olarak eklenebilir (görevler doğrudan
 * klasörde çalışır, değişiklikler depo başına incelenir). Depo yoksa hiçbir şey çizmez.
 */
export function FolderRepositoriesNotice({ path, enabled }: { path: string; enabled: boolean }) {
  const query = useQuery({
    queryKey: ['projectRepositories', 'discoverLocalFolder', path],
    queryFn: async () => (await getProjectRepositoriesClient()).discoverLocalFolder({ path }),
    enabled: enabled && path.length > 0,
    staleTime: 5_000,
  });
  const repositories = query.data?.repositories ?? [];
  if (!enabled || repositories.length === 0) return null;
  const preview = repositories.slice(0, PREVIEW_LIMIT).map((repository) => repository.relativePath);
  const rest = repositories.length - preview.length;
  return (
    <div className="flex gap-2 border-b border-border px-2 py-1.5 text-xs text-foreground-muted">
      <FolderGit2 className="mt-0.5 size-3.5 shrink-0" />
      <div className="flex flex-col gap-0.5">
        <span>
          {`This folder holds ${repositories.length} Git repositories and can be added as a multi-repository project.`}
        </span>
        <span className="font-mono">
          {preview.join(', ')}
          {rest > 0 ? ` +${rest}` : ''}
        </span>
        <span>
          Tasks work directly in this folder. Review and commit each repository from the Changes
          panel.
        </span>
      </div>
    </div>
  );
}
