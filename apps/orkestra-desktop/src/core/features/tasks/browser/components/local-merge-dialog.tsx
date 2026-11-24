import type { LocalMergeStrategy } from '@orkestra/core/runtimes/git/api';
import {
  Alert,
  Button,
  Dialog,
  Input,
  Label,
  Select,
  Switch,
  toast,
} from '@orkestra/ui/react/primitives';
import { GitMerge } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { mergeLocalBranch } from '@core/features/source-control/api/browser/client';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';

export type LocalMergeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  taskId: string;
  taskName: string;
  sourceBranch: string;
  targetBranch: string;
  hasUncommittedChanges: boolean;
  onMerged?: (action: 'keep' | 'archive') => void;
};

export function LocalMergeDialog({
  open,
  onOpenChange,
  projectId,
  taskId,
  taskName,
  sourceBranch,
  targetBranch,
  hasUncommittedChanges,
  onMerged,
}: LocalMergeDialogProps) {
  const [strategy, setStrategy] = useState<LocalMergeStrategy>('squash');
  const [commitMessage, setCommitMessage] = useState(taskName || sourceBranch);
  const [archiveAfterMerge, setArchiveAfterMerge] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [conflictFiles, setConflictFiles] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setCommitMessage(taskName || sourceBranch);
    setErrorMessage(null);
    setConflictFiles([]);
  }, [open, taskName, sourceBranch]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasUncommittedChanges || isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    setConflictFiles([]);

    try {
      const result = await mergeLocalBranch({
        projectId,
        sourceBranch,
        targetBranch,
        strategy,
        commitMessage: commitMessage.trim() || taskName || sourceBranch,
      });

      if (!result.success) {
        const msg =
          result.error.type === 'repository-unavailable' || result.error.type === 'project-missing'
            ? 'Proje veya depo şu anda kullanılabilir değil.'
            : 'message' in result.error && typeof result.error.message === 'string'
              ? result.error.message
              : `Birleştirme hatası: ${result.error.type}`;
        setErrorMessage(msg);
        return;
      }

      const data = result.data;
      switch (data.kind) {
        case 'merged': {
          toast.success(`'${sourceBranch}' dalı '${targetBranch}' içine birleştirildi`, {
            description:
              data.mergedCommits > 0
                ? `${data.mergedCommits} commit · ${data.commitHash.slice(0, 7)}`
                : data.commitHash.slice(0, 7),
          });
          if (archiveAfterMerge) {
            await getTaskManagerStore(projectId)?.archiveTask(taskId);
            onOpenChange(false);
            onMerged?.('archive');
          } else {
            onOpenChange(false);
            onMerged?.('keep');
          }
          break;
        }
        case 'already-up-to-date': {
          toast.info(`'${targetBranch}' dalı zaten güncel`);
          onOpenChange(false);
          break;
        }
        case 'dirty-target': {
          setErrorMessage(data.message);
          break;
        }
        case 'merge-conflict': {
          setErrorMessage(data.message);
          setConflictFiles(data.files);
          break;
        }
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="md">
        <form onSubmit={handleSubmit}>
          <Dialog.Header>
            <Dialog.Title className="flex items-center gap-2">
              <GitMerge className="size-4" />
              Yerel Dalı Birleştir
            </Dialog.Title>
          </Dialog.Header>
          <Dialog.Body className="flex flex-col gap-4">
            <Dialog.Description>
              <code className="font-mono text-xs text-foreground">{sourceBranch}</code> dalındaki
              değişiklikleri{' '}
              <code className="font-mono text-xs text-foreground">{targetBranch}</code> dalına
              birleştirir (uzak sunucuya push etmez).
            </Dialog.Description>

            {hasUncommittedChanges && (
              <Alert.Root status="warning">
                <Alert.Description>
                  Çalışma ağacında henüz commit atılmamış değişiklikler var. Birleştirmeden önce tüm
                  değişiklikleri commit atın.
                </Alert.Description>
              </Alert.Root>
            )}

            {errorMessage && (
              <Alert.Root status="destructive">
                <div className="flex flex-col gap-1.5">
                  <Alert.Description>{errorMessage}</Alert.Description>
                  {conflictFiles.length > 0 && (
                    <ul className="list-disc space-y-0.5 pl-4 font-mono text-[11px]">
                      {conflictFiles.slice(0, 8).map((file) => (
                        <li key={file}>{file}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </Alert.Root>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="local-merge-strategy">Birleştirme stratejisi</Label>
              <Select.Root
                value={strategy}
                onValueChange={(value) => {
                  if (value === 'squash' || value === 'merge') {
                    setStrategy(value);
                  }
                }}
              >
                <Select.Trigger id="local-merge-strategy">
                  <Select.Value>
                    {strategy === 'squash'
                      ? 'Squash & Birleştir (Tek commit · Önerilen)'
                      : 'Merge Commit (Tüm commit geçmişini koru)'}
                  </Select.Value>
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="squash">
                    Squash & Birleştir (Tek commit · Önerilen)
                  </Select.Item>
                  <Select.Item value="merge">
                    Merge Commit (Tüm commit geçmişini koru)
                  </Select.Item>
                </Select.Content>
              </Select.Root>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="local-merge-message">Commit mesajı</Label>
              <Input
                id="local-merge-message"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder={`${taskName || sourceBranch}`}
                disabled={isSubmitting}
              />
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-surface-subtle/40 px-3 py-2">
              <div className="flex flex-col">
                <span className="text-xs font-medium text-foreground">
                  Birleştirme sonrası görevi arşivle
                </span>
                <span className="text-[11px] text-foreground-muted">
                  Tamamlanan çalışma ağacını kenar çubuğundan kaldırır.
                </span>
              </div>
              <Switch
                aria-label="Birleştirme sonrası görevi arşivle"
                checked={archiveAfterMerge}
                onCheckedChange={setArchiveAfterMerge}
                disabled={isSubmitting}
              />
            </div>
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.Close render={<Button variant="ghost">İptal</Button>} />
            <Button
              type="submit"
              variant="primary"
              disabled={hasUncommittedChanges || isSubmitting}
            >
              {isSubmitting ? 'Birleştiriliyor…' : `${targetBranch} dalına birleştir`}
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
