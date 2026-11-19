import type {
  Checkpoint,
  CheckpointChangeKind,
  CheckpointRestorePreview,
} from '@orkestra/core/runtimes/git/api';

/** The checkpoint taken right before `promptId` was sent, if it still exists. */
export function findPromptCheckpoint(
  checkpoints: readonly Checkpoint[],
  promptId: string
): Checkpoint | null {
  return (
    checkpoints.find(
      (checkpoint) => checkpoint.kind === 'prompt' && checkpoint.promptId === promptId
    ) ?? null
  );
}

export const CHANGE_LABELS: Record<CheckpointChangeKind, string> = {
  delete: 'Silinecek (bu noktadan sonra eklenmiş)',
  overwrite: 'Eski haline dönecek',
  recreate: 'Yeniden oluşturulacak (sonradan silinmiş)',
};

export const CHANGE_ORDER: readonly CheckpointChangeKind[] = ['overwrite', 'recreate', 'delete'];

/** Preview files grouped by what restoring would do to them, in display order. */
export function groupPreviewFiles(preview: CheckpointRestorePreview) {
  return CHANGE_ORDER.map((change) => ({
    change,
    label: CHANGE_LABELS[change],
    total: preview[change],
    paths: preview.files.filter((file) => file.change === change).map((file) => file.path),
  })).filter((group) => group.total > 0);
}

export function previewIsEmpty(preview: CheckpointRestorePreview): boolean {
  return preview.recreate + preview.overwrite + preview.delete === 0;
}

/** Turkish, user-facing text for any error the checkpoint procedures can return or throw. */
export function describeCheckpointError(error: unknown): string {
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
    const type = (error as { type?: unknown }).type;
    if (typeof type === 'string') return `İşlem başarısız oldu (${type}).`;
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Bilinmeyen bir hata oluştu.';
}

export function describeRestoreSummary(counts: {
  recreate: number;
  overwrite: number;
  delete: number;
}): string {
  const total = counts.recreate + counts.overwrite + counts.delete;
  if (total === 0) return 'Dosyalarda değişiklik gerekmedi.';
  return `${counts.overwrite} dosya eski haline döndü, ${counts.recreate} dosya yeniden oluşturuldu, ${counts.delete} dosya silindi.`;
}
