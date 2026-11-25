import { toast } from '@orkestra/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import {
  isReviewFileViewed,
  type ReviewGuideFileInput,
} from '@core/features/code-review/api/review-guide';
type ReviewFileView = {
  path: string;
  state: 'VIEWED' | 'UNVIEWED' | 'DISMISSED';
};

type ReviewFileViews = {
  account: string;
  files?: ReviewFileView[];
  marks?: { path: string; revision: string }[];
};

export interface ReviewGuideSession {
  id: string;
  revision: string;
  readFileViews(signal: AbortSignal): Promise<ReviewFileViews>;
  setFileViewed(
    account: string,
    path: string,
    viewed: boolean,
    diffRevision: string
  ): Promise<void>;
}

export function useReviewProgress(
  open: boolean,
  files: readonly ReviewGuideFileInput[],
  session: ReviewGuideSession | undefined
) {
  const [local, setLocal] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const writeInProgress = useRef(false);
  const queryClient = useQueryClient();
  const queryKey = ['review-guide-file-views', session?.id, session?.revision] as const;
  const views = useQuery({
    queryKey,
    enabled: open && Boolean(session),
    retry: false,
    refetchInterval: 30_000,
    queryFn: ({ signal }) => session!.readFileViews(signal),
  });
  const account = views.data?.account;
  const revision = session?.revision;
  const revisions = useMemo(
    () => new Map(revision ? files.map((file) => [file.path, file.diffRevision ?? revision]) : []),
    [files, revision]
  );
  const persisted = new Map(views.data?.marks?.map(({ path, revision }) => [path, revision]));
  const remoteFiles = views.data?.files;
  const remote = remoteFiles && new Map(remoteFiles.map(({ path, state }) => [path, state]));

  const reviewed = session
    ? new Set(
        [...revisions]
          .filter(([path, revision]) =>
            isReviewFileViewed(
              revision,
              persisted.get(path),
              remote ? remote.get(path) === 'VIEWED' : undefined
            )
          )
          .map(([path]) => path)
      )
    : local;

  async function toggle(path: string) {
    const viewed = !reviewed.has(path);
    if (!session) {
      setLocal((previous) => {
        const next = new Set(previous);
        if (viewed) next.add(path);
        else next.delete(path);
        return next;
      });
      return;
    }

    const revision = revisions.get(path);
    if (!account || !revision || views.isError || writeInProgress.current) return;
    writeInProgress.current = true;
    setSaving(true);
    try {
      await queryClient.cancelQueries({ queryKey });
      await session.setFileViewed(account, path, viewed, revision);
      queryClient.setQueryData<ReviewFileViews>(queryKey, (current) => {
        if (current?.account !== account) return current;
        const marks = (current.marks ?? []).filter((entry) => entry.path !== path);
        if (viewed) marks.push({ path, revision });
        const state = viewed ? 'VIEWED' : 'UNVIEWED';
        const files = current.files
          ? [
              ...current.files.filter((entry) => entry.path !== path),
              { path, state } as ReviewFileView,
            ]
          : undefined;
        return { ...current, marks, files };
      });
    } catch {
      toast.error('İnceleme işareti kaydedilemedi');
    } finally {
      writeInProgress.current = false;
      setSaving(false);
      void queryClient.invalidateQueries({ queryKey });
    }
  }

  return {
    reviewed,
    toggle,
    disabled: saving || Boolean(session && (!account || views.isError)),
    error: views.isError,
  };
}
