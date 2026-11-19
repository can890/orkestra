import {
  WORKFLOW_DEFAULT_STEP_TIMEOUT_MS,
  WORKFLOW_STORED_REPORT_CHARS,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowRunStep,
} from '@core/features/orchestra/api/workflow';
import { renderPrompt, topologicalOrder } from '@core/features/orchestra/api/workflow-logic';

/** İşçinin bir turunun sonucu. */
export type WorkerOutcome = {
  status: 'done' | 'error' | 'cancelled' | 'lost';
  report: string | null;
  errorMessage: string | null;
};

/**
 * Yürütücünün işçi işlemlerinden ayrıldığı sınır. Gerçek uygulama `workflow-worker-port.ts`
 * içindedir; testler sahte bir port kullanır.
 */
export interface WorkflowWorkerPort {
  /** Adım için yeni bir işçi sohbeti açıp oturumunu bağlar. */
  startWorker(input: {
    runId: string;
    stepId: string;
    agent: string;
    model: string | null;
    title: string;
    autoApprove: boolean;
  }): Promise<{ workerId: string }>;
  /** İşçiye istemi gönderir; turu tanımlayan istem kimliğini döner. */
  sendPrompt(input: { workerId: string; text: string }): Promise<{ promptId: string }>;
  /**
   * Turun bitmesini bekler. `signal` iptal edilince beklemeyi bırakır. Tur sürerken izin
   * beklenip beklenmediği `onPhase` ile bildirilir.
   */
  waitForReport(input: {
    workerId: string;
    promptId: string;
    autoApprove: boolean;
    signal: AbortSignal;
    onPhase: (phase: 'running' | 'awaiting-permission') => void;
  }): Promise<WorkerOutcome>;
  /** İşçinin çalışan turunu durdurur. */
  cancel(workerId: string): Promise<void>;
}

export type WorkflowRunnerOptions = {
  port: WorkflowWorkerPort;
  /** Her durum değişikliğinden sonra çağrılır (kalıcılık/arayüz için). */
  onChange?: (run: WorkflowRun) => void;
  /** Adım başına zaman aşımı (ms). */
  stepTimeoutMs?: number;
  now?: () => number;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
};

const TIMEOUT = Symbol('timeout');

function toError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clipStored(report: string | null): string | null {
  if (!report || report.length <= WORKFLOW_STORED_REPORT_CHARS) return report;
  return `${report.slice(0, WORKFLOW_STORED_REPORT_CHARS)}\n…[kısaltıldı]`;
}

/** Yeni bir çalıştırma kaydı: tüm adımlar `pending`. */
export function createWorkflowRun(input: {
  id: string;
  workflow: WorkflowDefinition;
  projectId: string;
  taskId: string;
  input: string;
  autoApprove: boolean;
  maxConcurrency: number;
  now: number;
}): WorkflowRun {
  return {
    id: input.id,
    workflowId: input.workflow.id,
    workflowName: input.workflow.name,
    projectId: input.projectId,
    taskId: input.taskId,
    input: input.input,
    autoApprove: input.autoApprove,
    maxConcurrency: input.maxConcurrency,
    status: 'running',
    createdAt: input.now,
    finishedAt: null,
    steps: input.workflow.steps.map((step) => ({
      id: step.id,
      agent: step.agent,
      model: step.model ?? null,
      dependsOn: [...step.dependsOn],
      status: 'pending',
      workerId: null,
      startedAt: null,
      finishedAt: null,
      report: null,
      error: null,
    })),
  };
}

/**
 * Şef LLM olmadan, tanımlı adımları bağımlılık sırasına göre çalıştırır: bağımlılıkları biten
 * adımlar başlar, bağımsız adımlar `run.maxConcurrency` ile sınırlı paralel çalışır. Başarısız
 * (ya da atlanan) bir adımın bağımlıları `skipped` olur, bağımsız dallar sürer.
 */
export class WorkflowRunner {
  private readonly now: () => number;

  constructor(private readonly options: WorkflowRunnerOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Çalıştırmayı sonuna kadar yürütür; `run` yerinde güncellenir. `signal` iptal edilirse çalışan
   * işçilerin turu iptal edilir ve bekleyen adımlar `cancelled` olur.
   */
  async execute(
    definition: WorkflowDefinition,
    run: WorkflowRun,
    signal: AbortSignal
  ): Promise<WorkflowRun> {
    const order = topologicalOrder(definition.steps);
    if (!order.ok) throw new Error(`Bağımlılıklarda döngü var: ${order.cycle.join(', ')}`);
    const stepById = new Map(run.steps.map((step) => [step.id, step]));
    const definitionById = new Map(definition.steps.map((step) => [step.id, step]));
    const indexOf = new Map(order.order.map((id, index) => [id, index]));
    const reports = new Map<string, string | null>();
    const running = new Map<string, Promise<void>>();
    const emit = () => this.options.onChange?.(run);

    const finishStep = (
      step: WorkflowRunStep,
      status: WorkflowRunStep['status'],
      patch: { report?: string | null; error?: string | null } = {}
    ) => {
      step.status = status;
      step.finishedAt = this.now();
      if (patch.report !== undefined) step.report = clipStored(patch.report);
      if (patch.error !== undefined) step.error = patch.error;
      if (status === 'completed') reports.set(step.id, patch.report ?? null);
      emit();
    };

    while (true) {
      if (signal.aborted) {
        for (const step of run.steps) {
          if (step.status === 'pending') finishStep(step, 'cancelled');
        }
      } else {
        // Başarısız/atlanan/iptal bir bağımlılığı olan adımlar atlanır; yayılım için döngüye girer.
        let changed = true;
        while (changed) {
          changed = false;
          for (const step of run.steps) {
            if (step.status !== 'pending') continue;
            const blocker = step.dependsOn.find((dep) => {
              const status = stepById.get(dep)?.status;
              return status === 'failed' || status === 'skipped' || status === 'cancelled';
            });
            if (blocker) {
              finishStep(step, 'skipped', { error: `"${blocker}" adımı tamamlanmadığı için atlandı.` });
              changed = true;
            }
          }
        }
        const ready = run.steps
          .filter(
            (step) =>
              step.status === 'pending' &&
              step.dependsOn.every((dep) => stepById.get(dep)?.status === 'completed')
          )
          .sort((a, b) => indexOf.get(a.id)! - indexOf.get(b.id)!);
        for (const step of ready) {
          if (running.size >= run.maxConcurrency) break;
          const definitionStep = definitionById.get(step.id)!;
          step.status = 'running';
          step.startedAt = this.now();
          emit();
          const task = this.runStep(run, step, definitionStep.prompt, reports, signal, emit)
            .then((result) => finishStep(step, result.status, result))
            .catch((error: unknown) => finishStep(step, 'failed', { error: toError(error) }))
            .finally(() => running.delete(step.id));
          running.set(step.id, task);
        }
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }

    run.status = signal.aborted
      ? 'cancelled'
      : run.steps.every((step) => step.status === 'completed')
        ? 'completed'
        : 'failed';
    run.finishedAt = this.now();
    emit();
    return run;
  }

  private async runStep(
    run: WorkflowRun,
    step: WorkflowRunStep,
    template: string,
    reports: ReadonlyMap<string, string | null>,
    runSignal: AbortSignal,
    emit: () => void
  ): Promise<{ status: WorkflowRunStep['status']; report?: string | null; error?: string | null }> {
    const { port } = this.options;
    const text = renderPrompt(template, { input: run.input, reports });
    const { workerId } = await port.startWorker({
      runId: run.id,
      stepId: step.id,
      agent: step.agent,
      model: step.model,
      title: `${run.workflowName} · ${step.id}`,
      autoApprove: run.autoApprove,
    });
    step.workerId = workerId;
    emit();
    if (runSignal.aborted) {
      await this.safeCancel(workerId);
      return { status: 'cancelled' };
    }
    const { promptId } = await port.sendPrompt({ workerId, text });

    // Adım iptali = çalıştırma iptali ya da zaman aşımı; ikisi de beklemeyi bırakır.
    const stepAbort = new AbortController();
    const onRunAbort = () => stepAbort.abort();
    runSignal.addEventListener('abort', onRunAbort, { once: true });
    const timeoutMs = this.options.stepTimeoutMs ?? WORKFLOW_DEFAULT_STEP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    });
    const aborted = new Promise<'aborted'>((resolve) => {
      if (stepAbort.signal.aborted) resolve('aborted');
      else stepAbort.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    try {
      const waiting = port.waitForReport({
        workerId,
        promptId,
        autoApprove: run.autoApprove,
        signal: stepAbort.signal,
        onPhase: (phase) => {
          if (step.status !== 'running' && step.status !== 'awaiting-permission') return;
          if (step.status === phase) return;
          step.status = phase;
          emit();
        },
      });
      // İptal/zaman aşımından sonra reddedilen bekleme işlenmemiş hata sayılmasın.
      waiting.catch(() => undefined);
      const result = await Promise.race([waiting, timeout, aborted]);
      if (result === TIMEOUT) {
        stepAbort.abort();
        await this.safeCancel(workerId);
        return {
          status: 'failed',
          error: `Adım ${Math.round(timeoutMs / 60_000)} dakikada bitmedi (zaman aşımı); işçi durduruldu.`,
        };
      }
      if (result === 'aborted') {
        await this.safeCancel(workerId);
        return { status: 'cancelled' };
      }
      switch (result.status) {
        case 'done':
          return { status: 'completed', report: result.report ?? '' };
        case 'cancelled':
          return { status: 'cancelled', report: result.report, error: result.errorMessage };
        case 'lost':
          return {
            status: 'failed',
            report: result.report,
            error: result.errorMessage ?? 'İşçinin sonucu belirlenemedi.',
          };
        default:
          return {
            status: 'failed',
            report: result.report,
            error: result.errorMessage ?? 'İşçi hata ile bitti.',
          };
      }
    } finally {
      clearTimeout(timer);
      runSignal.removeEventListener('abort', onRunAbort);
    }
  }

  private async safeCancel(workerId: string): Promise<void> {
    try {
      await this.options.port.cancel(workerId);
    } catch (error) {
      this.options.logger?.warn('İş akışı: işçi iptal edilemedi', { workerId, error: toError(error) });
    }
  }
}
