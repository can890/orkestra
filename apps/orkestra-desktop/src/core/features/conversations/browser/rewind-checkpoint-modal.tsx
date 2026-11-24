import type {
  CheckpointRestorePreview,
  RestoreCheckpointResult,
} from '@orkestra/core/runtimes/git/api';
import { Button, Checkbox, Dialog, Label, toast } from '@orkestra/ui/react/primitives';
import { useCallback, useEffect, useState } from 'react';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';
import { branchConversationFromBeforeItem } from './acp/message-branch-actions';
import type { VisibleTurnLike } from './handoff/switch-provider-in-place';
import {
  describeCheckpointError,
  describeRestoreSummary,
  findPromptCheckpoint,
  groupPreviewFiles,
  previewIsEmpty,
} from './rewind-checkpoint-model';

type Phase =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'ready'; preview: CheckpointRestorePreview }
  | { kind: 'restoring' }
  | { kind: 'restored'; result: RestoreCheckpointResult; undone: boolean }
  | { kind: 'failed'; message: string };

export function RewindCheckpointModal({
  conversationId,
  promptId,
  projectId,
  taskId,
  itemId,
  visibleTurns,
}: {
  conversationId: string;
  promptId: string;
  projectId?: string;
  taskId?: string;
  itemId?: string;
  visibleTurns?: readonly VisibleTurnLike[];
}) {
  const { complete } = useModalController('rewindCheckpointModal');
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const canBranchContext = Boolean(projectId && taskId && itemId);
  const [rewindContext, setRewindContext] = useState(true);
  useCloseGuard(phase.kind === 'restoring');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const client = await getConversationsClient();
        const listed = await client.checkpoints.list({ conversationId });
        if (!listed.success) throw listed.error;
        const checkpoint = findPromptCheckpoint(listed.data.checkpoints, promptId);
        if (!checkpoint) {
          if (!cancelled) setPhase({ kind: 'missing' });
          return;
        }
        const preview = await client.checkpoints.preview({ conversationId, seq: checkpoint.seq });
        if (!preview.success) throw preview.error;
        if (!cancelled) setPhase({ kind: 'ready', preview: preview.data });
      } catch (error) {
        if (!cancelled) setPhase({ kind: 'failed', message: describeCheckpointError(error) });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [conversationId, promptId]);

  const restore = useCallback(
    async (seq: number, undone: boolean) => {
      setPhase({ kind: 'restoring' });
      try {
        const client = await getConversationsClient();
        const result = await client.checkpoints.restore({ conversationId, seq });
        if (!result.success) throw result.error;

        if (!undone && projectId && taskId && itemId && rewindContext) {
          try {
            await branchConversationFromBeforeItem({
              projectId,
              taskId,
              sourceConversationId: conversationId,
              targetItemId: itemId,
              visibleTurns: visibleTurns ?? [],
            });
            toast.success('Dosyalar geri sarıldı ve temiz sohbet dalı açıldı.');
            complete(true);
            return;
          } catch (branchError) {
            toast.warning('Dosyalar geri sarıldı ancak temiz sohbet dalı açılamadı', {
              description: branchError instanceof Error ? branchError.message : String(branchError),
            });
          }
        }

        setPhase({ kind: 'restored', result: result.data, undone });
      } catch (error) {
        setPhase({ kind: 'failed', message: describeCheckpointError(error) });
      }
    },
    [complete, conversationId, itemId, projectId, rewindContext, taskId, visibleTurns]
  );

  const branchContextActive = canBranchContext && rewindContext;

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Dosyaları bu mesajdan önceki duruma geri sar</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <div className="flex flex-col gap-3 text-sm">
          <Content phase={phase} />
          {canBranchContext &&
          phase.kind !== 'missing' &&
          phase.kind !== 'failed' &&
          phase.kind !== 'restored' ? (
            <Label className="flex cursor-pointer items-center gap-2 rounded-md border border-border/70 bg-foreground/[0.03] px-2.5 py-2 text-xs text-foreground">
              <Checkbox
                checked={rewindContext}
                disabled={phase.kind !== 'ready'}
                onCheckedChange={(checked) => setRewindContext(Boolean(checked))}
              />
              <span>Sohbet bağlamını da bu mesajdan önceye geri sar (temiz dal aç)</span>
            </Label>
          ) : null}
          <p className="text-xs text-foreground-muted" role="note">
            {branchContextActive
              ? "Dosyalar geri sarılır ve bu mesajdan önceye temiz bir sohbet dalı açılır; ajan geri alınan düzenlemeleri hatırlamaz (eski sohbet geçmişi korunur). Git index'i, HEAD ve dal değişmez; .gitignore ile yok sayılan dosyalara dokunulmaz."
              : "Yalnızca dosyalar geri sarılır. Sohbet geçmişi ve ajanın bağlamı olduğu gibi kalır; ajan bu mesajdan sonra olanları hâlâ hatırlar. Git index'i, HEAD ve dal değişmez; .gitignore ile yok sayılan dosyalara dokunulmaz."}
          </p>
        </div>
      </Dialog.Body>
      <Dialog.Footer className="gap-2">
        {phase.kind === 'ready' ? (
          <>
            <Button variant="secondary" onClick={() => complete(false)}>
              Vazgeç
            </Button>
            <Button
              variant="primary"
              disabled={previewIsEmpty(phase.preview)}
              onClick={() => void restore(phase.preview.checkpoint.seq, false)}
            >
              Dosyaları geri sar
            </Button>
          </>
        ) : phase.kind === 'restored' && !phase.undone ? (
          <>
            <Button variant="secondary" onClick={() => void restore(phase.result.safetySeq, true)}>
              Geri sarmayı geri al
            </Button>
            <Button variant="primary" onClick={() => complete(true)}>
              Tamam
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            disabled={phase.kind === 'restoring'}
            onClick={() => complete(phase.kind === 'restored')}
          >
            Kapat
          </Button>
        )}
      </Dialog.Footer>
    </>
  );
}

function Content({ phase }: { phase: Phase }) {
  switch (phase.kind) {
    case 'loading':
      return <p>Değişiklikler hesaplanıyor…</p>;
    case 'restoring':
      return <p>Dosyalar geri sarılıyor…</p>;
    case 'missing':
      return (
        <p>
          Bu mesaj için checkpoint bulunamadı. Checkpoint&apos;ler her mesajdan önce alınır ve
          sohbet başına en son 50 tanesi saklanır; bu mesaj daha eski olabilir ya da özellik
          eklenmeden önce gönderilmiş olabilir.
        </p>
      );
    case 'failed':
      return <p className="text-destructive">{phase.message}</p>;
    case 'restored':
      return (
        <div className="flex flex-col gap-1">
          <p>
            {phase.undone ? 'Geri sarma geri alındı. ' : 'Geri sarıldı. '}
            {describeRestoreSummary(phase.result)}
          </p>
          {!phase.undone && (
            <p className="text-xs text-foreground-muted">
              Önceki durumunuz #{phase.result.safetySeq} numaralı checkpoint olarak saklandı.
            </p>
          )}
          {phase.result.skipped.length > 0 && (
            <div className="text-destructive text-xs">
              <p>
                {phase.result.skipped.length} yol geri yüklenmedi: yerlerinde git&apos;in yok
                saydığı (ignore) dosyalar var ve bunlar hiçbir checkpoint&apos;te saklanmadığı için
                silinmedi.
              </p>
              <ul className="mt-1 list-disc pl-4 font-mono">
                {phase.result.skipped.slice(0, 10).map((skippedPath) => (
                  <li key={skippedPath}>{skippedPath}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      );
    case 'ready': {
      if (previewIsEmpty(phase.preview)) {
        return <p>Dosyalarda değişiklik yok; çalışma ağacı zaten bu noktadaki durumda.</p>;
      }
      return (
        <div className="flex flex-col gap-3">
          <p>
            Geri sarmadan önce mevcut durumunuz otomatik olarak yeni bir checkpoint&apos;e
            kaydedilir, böylece geri sarmayı geri alabilirsiniz.
          </p>
          {groupPreviewFiles(phase.preview).map((group) => (
            <div key={group.change} className="flex flex-col gap-1">
              <p className="font-medium">
                {group.label}: {group.total}
              </p>
              <ul className="max-h-40 overflow-y-auto rounded border border-border px-2 py-1 font-mono text-xs">
                {group.paths.map((path) => (
                  <li key={path} className="truncate" title={path}>
                    {path}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {phase.preview.truncated && (
            <p className="text-xs text-foreground-muted">
              Liste kısaltıldı; toplamlar eksiksizdir.
            </p>
          )}
        </div>
      );
    }
  }
}

export const rewindCheckpointModal = defineModal<boolean>()({
  id: 'rewindCheckpointModal',
  component: RewindCheckpointModal,
  size: 'md',
});
