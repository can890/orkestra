import type { GitDiffHunk, GitHunkAction, GitHunkScope } from '@orkestra/core/runtimes/git/api';
import { toast } from '@orkestra/ui/react/primitives';
import type * as monaco from 'monaco-editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitCheckoutStore } from '../../stores/git-checkout-store';
import type { DiffTabResource } from '../stores/diff-tab-resource';
import { MonacoHunkManager } from './monaco-hunk-manager';

type DiffGroup = DiffTabResource['diffGroup'];

interface UseDiffEditorHunksOptions {
  editor: monaco.editor.IStandaloneDiffEditor | null;
  gitCheckout: GitCheckoutStore;
  filePath: string;
  diffGroup: DiffGroup;
  revision: number;
}

function diffGroupToHunkScope(group: DiffGroup): GitHunkScope | null {
  if (group === 'disk') return 'unstaged';
  if (group === 'staged') return 'staged';
  return null;
}

export function useDiffEditorHunks({
  editor,
  gitCheckout,
  filePath,
  diffGroup,
  revision,
}: UseDiffEditorHunksOptions): void {
  const scope = diffGroupToHunkScope(diffGroup);
  const managerRef = useRef<MonacoHunkManager | null>(null);
  const [hunks, setHunks] = useState<GitDiffHunk[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  const handleApplyHunk = useCallback(
    async (hunk: GitDiffHunk, _targetScope: GitHunkScope, action: GitHunkAction) => {
      const result = await gitCheckout.applyHunk(action, hunk.patch);
      if (!result.success) {
        const message =
          'message' in result.error && typeof result.error.message === 'string'
            ? result.error.message
            : `Değişiklik bloğu uygulanamadı (${result.error.type})`;
        toast.error('Hunk işlemi başarısız', { description: message });
        return;
      }
      setRefreshTick((tick) => tick + 1);
    },
    [gitCheckout]
  );

  useEffect(() => {
    if (!editor) return;
    const manager = new MonacoHunkManager(editor, { onApplyHunk: handleApplyHunk });
    managerRef.current = manager;
    return () => {
      manager.dispose();
      managerRef.current = null;
    };
  }, [editor, handleApplyHunk]);

  useEffect(() => {
    let cancelled = false;
    if (!scope) {
      setHunks([]);
      return;
    }

    void gitCheckout
      .getFileHunks(filePath, scope)
      .then((result) => {
        if (cancelled) return;
        setHunks(result.success ? result.data.hunks : []);
      })
      .catch(() => {
        if (!cancelled) setHunks([]);
      });

    return () => {
      cancelled = true;
    };
  }, [gitCheckout, filePath, scope, revision, refreshTick]);

  useEffect(() => {
    managerRef.current?.setHunks(hunks, scope);
  }, [hunks, scope]);
}
