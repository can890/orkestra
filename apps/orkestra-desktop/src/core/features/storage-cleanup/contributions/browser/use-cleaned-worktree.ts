import { useEffect, useState } from 'react';
import { getStorageCleanupClient } from '../../api/browser/client';
import type { CleanedWorktree } from '../../api/contract';

/**
 * Görevin worktree'si depolama temizliğiyle kaldırıldıysa ayrıntısı (neden, zaman);
 * değilse null. Eksik workspace ekranı bunu "Worktree cleaned up" olarak gösterir.
 */
export function useCleanedWorktree(workspaceId: string | null | undefined): CleanedWorktree | null {
  const [cleaned, setCleaned] = useState<CleanedWorktree | null>(null);
  useEffect(() => {
    setCleaned(null);
    if (!workspaceId) return;
    let cancelled = false;
    void getStorageCleanupClient()
      .then((client) => client.getCleanedWorktree({ workspaceId }))
      .then((result) => {
        if (!cancelled) setCleaned(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);
  return cleaned;
}
