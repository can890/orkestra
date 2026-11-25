import type { GitStatusCode } from '@orkestra/core/runtimes/git/api';
import { Button, Select } from '@orkestra/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderGit2, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { getProjectRepositoriesClient } from '@core/features/project-repositories/api/browser/client';
import type {
  ListProjectRepositoriesResult,
  ProjectRepositoryInfo,
} from '@core/features/project-repositories/api/contract';
import { RepositoryCheckoutView } from './repository-checkout-view';

const ALL_REPOSITORIES = '__all__';

export type MultiRepositoryTarget = Readonly<{
  projectId: string;
  workspaceId: string;
  sshConnectionId?: string;
}>;

export function projectRepositoriesQueryKey(projectId: string, workspaceId: string) {
  return ['projectRepositories', 'list', projectId, workspaceId] as const;
}

/** Görev klasörünün kapsadığı depolar (yerel host'ta diskten okunur). */
export function useTaskRepositories({ projectId, workspaceId }: MultiRepositoryTarget) {
  return useQuery({
    queryKey: projectRepositoriesQueryKey(projectId, workspaceId),
    queryFn: async (): Promise<ListProjectRepositoriesResult> =>
      (await getProjectRepositoriesClient()).listRepositories({ projectId, workspaceId }),
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });
}

export function discoveredRepositories(
  result: ListProjectRepositoriesResult | undefined
): ProjectRepositoryInfo[] {
  return result?.status === 'ok' ? result.repositories : [];
}

/**
 * Çok depolu bir görevin değişiklik paneli: depo seçici, "Tüm depolar" görünümü (yollar deponun
 * göreli klasörüyle önekli) ve seçilen depo için tek depolu kaynak kontrolü (status, diff, stage,
 * commit, push). Git işlemleri her zaman tek bir depoda çalışır.
 */
export function MultiRepositoryChangesPanel(
  props: MultiRepositoryTarget & { repositories: ProjectRepositoryInfo[] }
) {
  const { repositories } = props;
  const [selected, setSelected] = useState<string>(ALL_REPOSITORIES);
  const queryClient = useQueryClient();
  const changesKey = ['projectRepositories', 'changes', props.projectId, props.workspaceId];
  const selectedRepository = repositories.find(
    (repository) => repository.relativePath === selected
  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['projectRepositories'] });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <FolderGit2 className="size-3.5 shrink-0 text-foreground-muted" />
        <Select.Root value={selected} onValueChange={(value) => setSelected(String(value))}>
          <Select.Trigger className="min-w-0 flex-1" aria-label="Repository">
            <Select.Value>
              {selectedRepository ? selectedRepository.relativePath : 'All repositories'}
            </Select.Value>
          </Select.Trigger>
          <Select.Content align="start" className="min-w-max">
            <Select.Item value={ALL_REPOSITORIES}>All repositories</Select.Item>
            {repositories.map((repository) => (
              <Select.Item key={repository.relativePath} value={repository.relativePath}>
                {repository.relativePath}
                {repository.kind === 'submodule' ? ' (submodule)' : ''}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Refresh repositories"
          title="Refresh repositories"
          onClick={refresh}
        >
          <RotateCw className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {selectedRepository ? (
          <RepositoryCheckoutView
            key={selectedRepository.relativePath}
            projectId={props.projectId}
            workspaceId={props.workspaceId}
            sshConnectionId={props.sshConnectionId}
            repository={selectedRepository}
            onChanged={() => void queryClient.invalidateQueries({ queryKey: changesKey })}
          />
        ) : (
          <AllRepositoriesChanges {...props} queryKey={changesKey} onSelect={setSelected} />
        )}
      </div>
    </div>
  );
}

function AllRepositoriesChanges({
  workspaceId,
  queryKey,
  onSelect,
}: MultiRepositoryTarget & {
  queryKey: readonly unknown[];
  onSelect: (relativePath: string) => void;
}) {
  const changes = useQuery({
    queryKey,
    queryFn: async () => (await getProjectRepositoriesClient()).listChanges({ workspaceId }),
    refetchOnWindowFocus: true,
  });

  if (changes.isPending) {
    return <div className="p-3 text-sm text-foreground-muted">Reading repository changes…</div>;
  }
  if (changes.error || !changes.data || changes.data.status !== 'ok') {
    return (
      <div className="p-3 text-sm text-foreground-muted">
        Repository changes are unavailable for this workspace.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-2 text-sm">
      {changes.data.repositories.map((repository) => (
        <div key={repository.relativePath} className="flex flex-col">
          <button
            type="button"
            className="flex items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-background-1"
            onClick={() => onSelect(repository.relativePath)}
            title="Open this repository"
          >
            <span className="min-w-0 truncate font-medium">{repository.relativePath}</span>
            {repository.branch && (
              <span className="truncate text-xs text-foreground-muted">{repository.branch}</span>
            )}
            <span className="flex-1" />
            <span className="text-xs text-foreground-muted">
              {repository.tooManyFiles ? 'Too many files' : repository.files.length}
            </span>
          </button>
          {repository.error && (
            <span className="px-1 text-xs text-foreground-destructive">{repository.error}</span>
          )}
          {repository.files.map((file) => (
            <div key={file.path} className="flex items-center gap-2 px-3 py-0.5">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
                {file.path}
              </span>
              <span className="text-xs text-foreground-muted">
                {fileStatusLabel(file.index, file.worktree)}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// Porcelain durum kodlarının görünen adları (etiket tablosu Türkçe yamayla çevrilir).
const GIT_STATUS_CODE_LABELS: Record<GitStatusCode, string> = {
  unmodified: 'Unmodified',
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  'type-changed': 'Type changed',
  untracked: 'Untracked',
  ignored: 'Ignored',
  unmerged: 'Conflicted',
};

function statusCodeLabel(code: string): string {
  return Object.hasOwn(GIT_STATUS_CODE_LABELS, code)
    ? GIT_STATUS_CODE_LABELS[code as GitStatusCode]
    : code;
}

/**
 * Dosyanın durum etiketi. Bileşik biçimler tek bir çevrilebilir şablondur (parça birleştirme
 * yok); işlev adı `…Label` olduğu için Türkçe yama dönüş değerlerini çevirir.
 */
export function fileStatusLabel(index: string, worktree: string): string {
  if (index === 'untracked' || worktree === 'untracked') return GIT_STATUS_CODE_LABELS.untracked;
  if (index !== 'unmodified' && worktree !== 'unmodified') {
    return `${statusCodeLabel(index)} (staged), ${statusCodeLabel(worktree)}`;
  }
  return index !== 'unmodified' ? `${statusCodeLabel(index)} (staged)` : statusCodeLabel(worktree);
}

/**
 * Proje klasörü depo değilse ama depolar içeriyorsa çok depolu paneli, aksi halde `fallback`'i
 * (ör. "Git'i başlat" boş durumu) gösterir.
 */
export function MultiRepositoryOrFallback(
  props: MultiRepositoryTarget & { fallback: React.ReactNode }
) {
  const query = useTaskRepositories(props);
  const repositories = discoveredRepositories(query.data);
  if (query.isPending) return null;
  if (repositories.length === 0) return <>{props.fallback}</>;
  return <MultiRepositoryChangesPanel {...props} repositories={repositories} />;
}

/**
 * Kök klasörü de depo olan bir görevde iç depolar/alt modüller varsa, değişiklik panelinin altında
 * açılır bir "Diğer depolar" bölümü gösterir. İç depo yoksa hiçbir şey çizmez.
 */
export function NestedRepositoriesSection(props: MultiRepositoryTarget) {
  const query = useTaskRepositories(props);
  const repositories = discoveredRepositories(query.data);
  const [open, setOpen] = useState(false);
  if (repositories.length === 0) return null;
  return (
    <div className="flex min-h-0 flex-col border-t border-border">
      <button
        type="button"
        className="flex items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground-muted hover:bg-background-1"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <FolderGit2 className="size-3.5" />
        <span>{`Other repositories (${repositories.length})`}</span>
      </button>
      {open && (
        <div className="h-80 min-h-0">
          <MultiRepositoryChangesPanel {...props} repositories={repositories} />
        </div>
      )}
    </div>
  );
}
