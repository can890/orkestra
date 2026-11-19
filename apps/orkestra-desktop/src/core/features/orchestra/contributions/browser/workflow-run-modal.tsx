import { Badge, Button, Dialog, type BadgeTone } from '@orkestra/ui/react/primitives';
import { useCallback, useEffect, useState } from 'react';
import { getWorkflowsClient } from '@core/features/orchestra/api/browser/workflow-client';
import type {
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStepStatus,
} from '@core/features/orchestra/api/workflow';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';

const POLL_MS = 1_500;

const STEP_LABEL: Record<WorkflowStepStatus, string> = {
  pending: 'Bekliyor',
  running: 'Çalışıyor',
  'awaiting-permission': 'İzin bekliyor',
  completed: 'Tamamlandı',
  failed: 'Başarısız',
  skipped: 'Atlandı',
  cancelled: 'İptal edildi',
};

const STEP_TONE: Record<WorkflowStepStatus, BadgeTone> = {
  pending: 'neutral',
  running: 'info',
  'awaiting-permission': 'warning',
  completed: 'success',
  failed: 'error',
  skipped: 'neutral',
  cancelled: 'neutral',
};

const RUN_LABEL: Record<WorkflowRunStatus, string> = {
  running: 'Çalışıyor',
  completed: 'Tamamlandı',
  failed: 'Başarısız',
  cancelled: 'İptal edildi',
};

const RUN_TONE: Record<WorkflowRunStatus, BadgeTone> = {
  running: 'info',
  completed: 'success',
  failed: 'error',
  cancelled: 'neutral',
};

function formatDuration(start: number | null, end: number | null, now: number): string | null {
  if (!start) return null;
  const seconds = Math.max(0, Math.round(((end ?? now) - start) / 1000));
  return seconds < 60 ? `${seconds} sn` : `${Math.floor(seconds / 60)} dk ${seconds % 60} sn`;
}

export function WorkflowRunModal({ runId }: { runId: string }) {
  const { dismiss } = useModalController('workflowRunModal');
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setRun(await (await getWorkflowsClient()).getRun({ runId }));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Çalıştırma okunamadı');
    }
    setNow(Date.now());
  }, [runId]);

  const finished = run !== null && run.status !== 'running';
  useEffect(() => {
    void load();
    if (finished) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load, finished]);

  const cancel = async () => {
    setCancelling(true);
    try {
      await (await getWorkflowsClient()).cancelRun({ runId });
      await load();
    } finally {
      setCancelling(false);
    }
  };

  const openWorker = (workerId: string) => {
    if (!run) return;
    getTaskComposition(run.projectId, run.taskId)?.paneLayout.open(
      'acp-chat',
      { conversationId: workerId },
      { preview: false }
    );
    dismiss();
  };

  return (
    <>
      <Dialog.Header>
        <div className="flex items-center gap-2">
          <Dialog.Title>{run ? run.workflowName : 'İş akışı'}</Dialog.Title>
          {run ? <Badge tone={RUN_TONE[run.status]}>{RUN_LABEL[run.status]}</Badge> : null}
        </div>
      </Dialog.Header>
      <Dialog.Body>
        {error ? <p className="text-xs text-foreground-destructive">{error}</p> : null}
        {!run && !error ? <p className="text-xs text-foreground-muted">Yükleniyor...</p> : null}
        {run ? (
          <div className="space-y-2">
            {run.maxConcurrency > 1 ? (
              <p className="text-xs text-foreground-warning">
                {run.maxConcurrency} adım paralel çalışabilir; aynı worktree'de çalışan ajanlar
                birbirinin dosyalarını ezebilir.
              </p>
            ) : null}
            {run.steps.map((step) => {
              const duration = formatDuration(step.startedAt, step.finishedAt, now);
              return (
                <div key={step.id} className="space-y-1 rounded-md border border-border p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{step.id}</span>
                    <Badge tone={STEP_TONE[step.status]}>{STEP_LABEL[step.status]}</Badge>
                    <span className="text-xs text-foreground-muted">
                      {step.agent}
                      {step.model ? ` · ${step.model}` : ''}
                      {duration ? ` · ${duration}` : ''}
                    </span>
                    <div className="ml-auto" />
                    {step.workerId ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openWorker(step.workerId!)}
                      >
                        Sohbeti aç
                      </Button>
                    ) : null}
                  </div>
                  {step.dependsOn.length > 0 ? (
                    <p className="text-xs text-foreground-muted">
                      Bağlı olduğu adımlar: {step.dependsOn.join(', ')}
                    </p>
                  ) : null}
                  {step.status === 'awaiting-permission' ? (
                    <p className="text-xs text-foreground-warning">
                      İşçi izin bekliyor; sohbetini açıp onaylayın.
                    </p>
                  ) : null}
                  {step.error ? (
                    <p className="text-xs text-foreground-destructive">{step.error}</p>
                  ) : null}
                  {step.report ? (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-foreground-muted">Rapor</summary>
                      <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap">
                        {step.report}
                      </pre>
                    </details>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </Dialog.Body>
      <Dialog.Footer className="gap-2 sm:gap-2">
        {run && run.status === 'running' ? (
          <Button
            variant="destructive"
            size="sm"
            disabled={cancelling}
            onClick={() => void cancel()}
          >
            {cancelling ? 'İptal ediliyor...' : 'Çalıştırmayı iptal et'}
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" onClick={dismiss}>
          Kapat
        </Button>
      </Dialog.Footer>
    </>
  );
}

export const workflowRunModal = defineModal()({
  id: 'workflowRunModal',
  component: WorkflowRunModal,
  size: 'lg',
});
