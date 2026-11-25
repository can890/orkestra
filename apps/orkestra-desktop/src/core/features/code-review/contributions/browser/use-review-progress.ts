import { toast } from '@orkestra/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewGuideFileInput } from '@core/features/code-review/api/review-guide';
type ReviewFileView = {
  path: string;
  state: 'VIEWED' | 'UNVIEWED' | 'DISMISSED';
};

type ReviewFileViews = { account: string; files?: ReviewFileView[] };

export interface ReviewGuideSession {
  id: string;
  revision: string;
  readFileViews(signal: AbortSignal): Promise<ReviewFileViews>;
  setFileViewed(account: string, path: string, viewed: boolean): Promise<void>;
}

type ReviewLedger = Map<string, string>;

function readLedger(key: string): ReviewLedger | undefined {
  try {
    const entries: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(entries)) {
      return new Map(
        entries.filter(
          (entry): entry is [string, string] =>
            Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'
        )
      );
    }
  } catch {
    // Tarayıcı depolamasına erişilemeyebilir.
  }
  return undefined;
}

function saveLedger(key: string, ledger: ReviewLedger): void {
  try {
    localStorage.setItem(key, JSON.stringify([...ledger]));
  } catch {
    // İlerleme oturum boyunca bellekte kalır.
  }
}

export function reconcileReviewLedger(
  ledger: ReadonlyMap<string, string>,
  revisions: ReadonlyMap<string, string>,
  remoteFiles: readonly ReviewFileView[]
): ReviewLedger {
  const next = new Map(ledger);
  for (const { path, state } of remoteFiles) {
    if (state === 'VIEWED') {
      const revision = revisions.get(path);
      // Diff içeriği değişen dosya yeniden incelenir.
      if (revision && !next.has(path)) next.set(path, revision);
    } else {
      next.delete(path);
    }
  }
  return next;
}

export function useReviewProgress(
  open: boolean,
  files: readonly ReviewGuideFileInput[],
  session: ReviewGuideSession | undefined
) {
  const [local, setLocal] = useState<Set<string>>(() => new Set());
  const [snapshot, setSnapshot] = useState<{ key: string; ledger: ReviewLedger }>();
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
  const key =
    session && account ? 'review-guide:' + JSON.stringify([session.id, account]) : undefined;
  const revision = session?.revision;
  const revisions = useMemo(
    () => new Map(revision ? files.map((file) => [file.path, file.diffRevision ?? revision]) : []),
    [files, revision]
  );
  const persisted =
    key && snapshot?.key === key ? snapshot.ledger : key ? readLedger(key) : undefined;
  const remoteFiles = views.data?.files;
  const ledger = remoteFiles
    ? reconcileReviewLedger(persisted ?? new Map(), revisions, remoteFiles)
    : (persisted ?? new Map());
  const reviewed = session
    ? new Set(
        [...revisions]
          .filter(([path, revision]) => ledger.get(path) === revision)
          .map(([path]) => path)
      )
    : local;

  useEffect(() => {
    if (key && remoteFiles && revisions.size > 0) {
      const next = reconcileReviewLedger(readLedger(key) ?? new Map(), revisions, remoteFiles);
      saveLedger(key, next);
      setSnapshot({ key, ledger: next });
    }
  }, [key, remoteFiles, views.dataUpdatedAt, revisions]);

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
    if (!key || !account || !revision || views.isError || writeInProgress.current) return;

    if (remoteFiles) {
      writeInProgress.current = true;
      setSaving(true);
      try {
        await queryClient.cancelQueries({ queryKey });
        await session.setFileViewed(account, path, viewed);
        queryClient.setQueryData<ReviewFileViews>(queryKey, (current) => {
          if (current?.account !== account || !current.files) return current;
          const state = viewed ? 'VIEWED' : 'UNVIEWED';
          return {
            ...current,
            files: [...current.files.filter((file) => file.path !== path), { path, state }],
          };
        });
      } catch {
        toast.error('GitHub inceleme işareti eşitlenemedi');
        return;
      } finally {
        writeInProgress.current = false;
        setSaving(false);
        void queryClient.invalidateQueries({ queryKey });
      }
    }
    const next = readLedger(key) ?? new Map(ledger);
    if (viewed) next.set(path, revision);
    else next.delete(path);
    saveLedger(key, next);
    setSnapshot({ key, ledger: next });
  }

  return {
    reviewed,
    toggle,
    disabled: saving || Boolean(session && (!key || views.isError)),
    error: views.isError,
  };
}
