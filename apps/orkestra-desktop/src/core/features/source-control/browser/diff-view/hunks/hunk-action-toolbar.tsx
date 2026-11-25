import type { GitDiffHunk, GitHunkAction, GitHunkScope } from '@orkestra/core/runtimes/git/api';
import { useState } from 'react';

export type HunkActionToolbarProps = {
  hunk: GitDiffHunk;
  scope: GitHunkScope;
  busy: boolean;
  onApply: (action: GitHunkAction) => void;
};

export function HunkActionToolbar({ hunk, scope, busy, onApply }: HunkActionToolbarProps) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  return (
    <div
      className="hunk-action-toolbar bg-surface-subtle/85 flex h-full items-center justify-between gap-2 border-y border-border/50 px-2.5 text-[11px] backdrop-blur-xs"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <span className="truncate font-mono text-[10px] text-foreground-muted">{hunk.header}</span>
      <div className="flex shrink-0 items-center gap-1.5">
        {scope === 'unstaged' ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmDiscard(false);
                onApply('stage');
              }}
              className="rounded border border-emerald-500/35 bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-700 transition-colors hover:bg-emerald-500/25 disabled:opacity-50 dark:text-emerald-300"
            >
              Hazırla
            </button>
            {confirmDiscard ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirmDiscard(false);
                    onApply('discard');
                  }}
                  className="rounded border border-red-500/50 bg-red-500/20 px-2 py-0.5 font-medium text-red-700 transition-colors hover:bg-red-500/30 disabled:opacity-50 dark:text-red-300"
                >
                  Onayla
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmDiscard(false)}
                  className="rounded border border-border/70 px-1.5 py-0.5 text-foreground-muted hover:text-foreground"
                >
                  İptal
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmDiscard(true)}
                className="rounded border border-border/70 bg-background/60 px-2 py-0.5 text-foreground-muted transition-colors hover:border-red-500/40 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-300"
              >
                Geri al
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => onApply('unstage')}
            className="rounded border border-amber-500/35 bg-amber-500/15 px-2 py-0.5 font-medium text-amber-700 transition-colors hover:bg-amber-500/25 disabled:opacity-50 dark:text-amber-300"
          >
            Hazırlıktan çıkar
          </button>
        )}
      </div>
    </div>
  );
}
