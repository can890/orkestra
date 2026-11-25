import type {
  GitChange,
  GitChangeStatus,
  GitDiffHunk,
  GitHunkScope,
} from '@orkestra/core/runtimes/git/api';
import { Button, Textarea, toast } from '@orkestra/ui/react/primitives';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Minus, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { ProjectRepositoryInfo } from '@core/features/project-repositories/api/contract';
import { nestedRepositoryWorkspaceId } from '@core/features/project-repositories/api/nested-repository-id';
import { getSourceControlClient } from '@core/features/source-control/api/browser/client';
import { runDesktopLiveJob } from '@core/primitives/wire/browser/run-live-job';
import { sourceControlContract } from '../../api';
import { GitCheckoutStore } from '../stores/git-checkout-store';

// Dosya değişiklik türü: ham `file.status` yerine gösterilir (etiket tablosu Türkçe yamayla çevrilir).
const GIT_CHANGE_STATUS_LABELS: Record<GitChangeStatus, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  conflicted: 'Conflicted',
};

type RepositoryTarget = Readonly<{
  projectId: string;
  workspaceId: string;
  sshConnectionId?: string;
  repository: ProjectRepositoryInfo;
}>;

/**
 * Çok depolu bir görevde seçilen tek deponun kaynak kontrolü: dal, ileri/geri sayısı, stage,
 * commit, push ve dosya başına diff. Kaynak kontrolü sözleşmesine bileşik çalışma alanı
 * kimliğiyle (`<workspaceId>::repo::<yol>`) bağlanır; tüm işlemler yalnızca bu depoda çalışır.
 */
export function RepositoryCheckoutView(props: RepositoryTarget & { onChanged?: () => void }) {
  const { projectId, workspaceId, sshConnectionId, repository } = props;
  const [store, setStore] = useState<GitCheckoutStore | null>(null);

  useEffect(() => {
    const next = new GitCheckoutStore(
      projectId,
      nestedRepositoryWorkspaceId(workspaceId, repository.relativePath),
      repository.path,
      sshConnectionId
    );
    next.start();
    setStore(next);
    return () => {
      next.dispose();
      setStore(null);
    };
  }, [projectId, workspaceId, sshConnectionId, repository.relativePath, repository.path]);

  if (!store) return null;
  return <RepositoryCheckoutBody {...props} store={store} />;
}

const RepositoryCheckoutBody = observer(function RepositoryCheckoutBody({
  workspaceId,
  repository,
  store,
  onChanged,
}: RepositoryTarget & { store: GitCheckoutStore; onChanged?: () => void }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<null | 'commit' | 'push' | 'pull' | 'stage'>(null);

  if (store.error) {
    return (
      <div className="flex flex-col gap-2 p-3 text-sm">
        <span className="text-foreground-muted">Git status unavailable</span>
        <span className="text-xs text-foreground-muted">{store.error}</span>
        <Button variant="secondary" size="sm" onClick={() => void store.retry()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!store.hasData) {
    return <div className="p-3 text-sm text-foreground-muted">Loading repository status…</div>;
  }

  const staged = store.stagedFileChanges;
  const unstaged = store.unstagedFileChanges;
  const remote =
    repository.remotes.find((candidate) => candidate.name === 'origin') ?? repository.remotes[0];
  const selector = {
    workspaceId: nestedRepositoryWorkspaceId(workspaceId, repository.relativePath),
  };

  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<void>) => {
    setBusy(kind);
    try {
      await work();
      onChanged?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const commit = () =>
    run('commit', async () => {
      const result = await store.commit(message.trim());
      if (!result.success) {
        toast.error('Commit failed', { description: describeError(result.error) });
        return;
      }
      setMessage('');
      toast(`Committed to ${repository.relativePath}`);
    });

  const push = () =>
    run('push', async () => {
      const client = await getSourceControlClient();
      const result = store.isPublished
        ? await runDesktopLiveJob(sourceControlContract.checkout.push, client.checkout.push, {
            ...selector,
            options: remote ? { remote: remote.name } : undefined,
          })
        : remote
          ? await runDesktopLiveJob(
              sourceControlContract.checkout.publish,
              client.checkout.publish,
              {
                ...selector,
                remote: remote.name,
              }
            )
          : null;
      if (result === null) {
        toast.error('This repository has no git remotes.');
        return;
      }
      if (!result.success) {
        toast.error('Push failed', { description: describeError(result.error) });
        return;
      }
      await store.resync();
      toast(`Pushed ${repository.relativePath}`);
    });

  const pull = () =>
    run('pull', async () => {
      const result = await store.pull();
      if (!result.success) {
        toast.error('Pull failed', { description: describeError(result.error) });
        return;
      }
      await store.resync();
    });

  const stage = (paths: string[] | 'all') =>
    run('stage', async () => {
      const result = paths === 'all' ? await store.stageAllFiles() : await store.stageFiles(paths);
      if (!result.success)
        toast.error('Stage failed', { description: describeError(result.error) });
    });

  const unstage = (paths: string[] | 'all') =>
    run('stage', async () => {
      const result =
        paths === 'all' ? await store.unstageAllFiles() : await store.unstageFiles(paths);
      if (!result.success) {
        toast.error('Unstage failed', { description: describeError(result.error) });
      }
    });

  return (
    <div className="flex min-h-0 flex-col gap-3 p-2 text-sm">
      <div className="flex items-center gap-2 px-1">
        <span className="min-w-0 truncate font-medium" title={repository.path}>
          {store.headDisplay ?? 'No branch'}
        </span>
        {store.isPublished && (store.aheadCount > 0 || store.behindCount > 0) && (
          <span className="flex items-center gap-1 text-xs text-foreground-muted">
            <ArrowUp className="size-3" />
            {store.aheadCount}
            <ArrowDown className="size-3" />
            {store.behindCount}
          </span>
        )}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null || !store.isPublished}
          onClick={() => void pull()}
        >
          Pull
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy !== null || !remote}
          title={remote ? `${remote.name}: ${remote.url}` : 'This repository has no git remotes.'}
          onClick={() => void push()}
        >
          {busy === 'push' ? 'Pushing…' : store.isPublished ? 'Push' : 'Publish branch'}
        </Button>
      </div>

      <FileGroup
        title="Staged"
        files={staged}
        scope="staged"
        store={store}
        actionLabel="Unstage"
        actionAllLabel="Unstage all"
        actionIcon={<Minus className="size-3.5" />}
        onAction={(paths) => void unstage(paths)}
        onActionAll={() => void unstage('all')}
        disabled={busy !== null}
      />
      <FileGroup
        title="Changed"
        files={unstaged}
        scope="unstaged"
        store={store}
        actionLabel="Stage"
        actionAllLabel="Stage all"
        actionIcon={<Plus className="size-3.5" />}
        onAction={(paths) => void stage(paths)}
        onActionAll={() => void stage('all')}
        disabled={busy !== null}
      />

      <div className="flex flex-col gap-2 px-1">
        <Textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={`Commit message for ${repository.relativePath}`}
          rows={2}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={busy !== null || staged.length === 0 || message.trim().length === 0}
          onClick={() => void commit()}
        >
          {busy === 'commit' ? 'Committing…' : 'Commit staged changes'}
        </Button>
      </div>
    </div>
  );
});

function FileGroup({
  title,
  files,
  scope,
  store,
  actionLabel,
  actionAllLabel,
  actionIcon,
  onAction,
  onActionAll,
  disabled,
}: {
  title: string;
  files: GitChange[];
  scope: GitHunkScope;
  store: GitCheckoutStore;
  actionLabel: string;
  actionAllLabel: string;
  actionIcon: React.ReactNode;
  onAction: (paths: string[]) => void;
  onActionAll: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-1 text-xs text-foreground-muted">
        <span className="font-medium uppercase">{title}</span>
        <span>{files.length}</span>
        <span className="flex-1" />
        {files.length > 0 && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onActionAll}>
            {actionAllLabel}
          </Button>
        )}
      </div>
      {files.length === 0 ? (
        <span className="px-1 py-1 text-xs text-foreground-muted">No files</span>
      ) : (
        files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            scope={scope}
            store={store}
            actionLabel={actionLabel}
            actionIcon={actionIcon}
            disabled={disabled}
            onAction={() => onAction([file.path])}
          />
        ))
      )}
    </div>
  );
}

function FileRow({
  file,
  scope,
  store,
  actionLabel,
  actionIcon,
  disabled,
  onAction,
}: {
  file: GitChange;
  scope: GitHunkScope;
  store: GitCheckoutStore;
  actionLabel: string;
  actionIcon: React.ReactNode;
  disabled: boolean;
  onAction: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col">
      <div className="group flex items-center gap-1 rounded px-1 hover:bg-background-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <span className="min-w-0 truncate font-mono text-xs" title={file.path}>
            {file.path}
          </span>
        </button>
        <span className="text-xs text-foreground-muted">
          {GIT_CHANGE_STATUS_LABELS[file.status]}
        </span>
        <Button
          variant="ghost"
          size="sm"
          title={actionLabel}
          aria-label={actionLabel}
          disabled={disabled}
          onClick={onAction}
        >
          {actionIcon}
        </Button>
      </div>
      {open && <FileDiff store={store} path={file.path} scope={scope} />}
    </div>
  );
}

function FileDiff({
  store,
  path,
  scope,
}: {
  store: GitCheckoutStore;
  path: string;
  scope: GitHunkScope;
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; hunks: GitDiffHunk[] }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const revision = store.statusRevision;

  useEffect(() => {
    let cancelled = false;
    void store
      .getFileHunks(path, scope)
      .then((result) => {
        if (cancelled) return;
        setState(
          result.success
            ? { kind: 'ready', hunks: result.data.hunks }
            : { kind: 'error', message: describeError(result.error) }
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [store, path, scope, revision]);

  if (state.kind === 'loading') {
    return <div className="px-6 py-1 text-xs text-foreground-muted">Loading diff…</div>;
  }
  if (state.kind === 'error') {
    return <div className="px-6 py-1 text-xs text-foreground-destructive">{state.message}</div>;
  }
  if (state.hunks.length === 0) {
    return (
      <div className="px-6 py-1 text-xs text-foreground-muted">
        No text diff to show (new, binary or renamed file).
      </div>
    );
  }
  return (
    <pre className="mx-1 my-1 max-h-80 overflow-auto rounded border border-border bg-background-1 p-2 font-mono text-[11px] leading-4">
      {state.hunks.map((hunk) => (
        <div key={hunk.id}>
          <div className="text-foreground-muted">{hunk.header}</div>
          {hunk.lines.map((line, index) => (
            <div
              key={index}
              className={
                line.startsWith('+')
                  ? 'text-foreground-diff-added'
                  : line.startsWith('-')
                    ? 'text-foreground-diff-deleted'
                    : undefined
              }
            >
              {line || ' '}
            </div>
          ))}
        </div>
      ))}
    </pre>
  );
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    if ('message' in error && typeof error.message === 'string') return error.message;
    if ('type' in error && typeof error.type === 'string') return error.type;
  }
  return String(error);
}
