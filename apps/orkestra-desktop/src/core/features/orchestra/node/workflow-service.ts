import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from '@orkestra/shared/logger';
import {
  WORKFLOW_MAX_CONCURRENCY,
  workflowRunStoreSchema,
  workflowStoreSchema,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@core/features/orchestra/api/workflow';
import { validateWorkflowDefinition } from '@core/features/orchestra/api/workflow-logic';
import {
  createWorkflowRun,
  WorkflowRunner,
  type WorkflowWorkerPort,
} from '@core/features/orchestra/node/workflow-runner';

/** Saklanan çalıştırma sayısı; en eskiler düşer. */
const MAX_STORED_RUNS = 50;
const RESTART_NOTE = 'Uygulama yeniden başladığı için iptal edildi.';

export type WorkflowServiceDeps = {
  dataDirectory: string;
  logger: Logger;
  /** Çalıştırma için işçi portu; proje/görev bağlamı çalıştırmaya özeldir. */
  createPort(context: { projectId: string; taskId: string }): WorkflowWorkerPort;
  stepTimeoutMs?: number;
};

type ActiveRun = { run: WorkflowRun; controller: AbortController; done: Promise<void> };

/**
 * İş akışı tanımlarını (`userData/orchestra/workflows.json`) ve çalıştırma kayıtlarını
 * (`workflow-runs.json`) tutar, çalıştırmaları yürütür. Uygulama yeniden açıldığında yarım kalmış
 * çalıştırmalar `cancelled` işaretlenir; otomatik devam yoktur.
 */
export class WorkflowService {
  private workflows: WorkflowDefinition[] = [];
  private runs: WorkflowRun[] = [];
  private loaded: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly active = new Map<string, ActiveRun>();

  constructor(private readonly deps: WorkflowServiceDeps) {}

  private path(name: string): string {
    return join(this.deps.dataDirectory, 'orchestra', name);
  }

  private async readJson(name: string): Promise<unknown> {
    const raw = await readFile(this.path(name), 'utf8').catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      this.deps.logger.warn(`İş akışı: ${name} okunamadı`, { error: String(error) });
      return null;
    }
  }

  private ensureLoaded(): Promise<void> {
    this.loaded ??= (async () => {
      const storedWorkflows = await this.readJson('workflows.json');
      if (storedWorkflows) {
        const parsed = workflowStoreSchema.safeParse(storedWorkflows);
        if (parsed.status === 'ok') this.workflows = parsed.data.workflows;
        else this.deps.logger.warn('İş akışı: tanım dosyası geçersiz, yok sayılıyor');
      }
      const storedRuns = await this.readJson('workflow-runs.json');
      if (storedRuns) {
        const parsed = workflowRunStoreSchema.safeParse(storedRuns);
        if (parsed.status === 'ok') this.runs = parsed.data.runs;
        else this.deps.logger.warn('İş akışı: çalıştırma kaydı geçersiz, yok sayılıyor');
      }
      if (this.markInterruptedRuns()) await this.persistRuns();
    })();
    return this.loaded;
  }

  /** Yarım kalmış çalıştırmaları ve adımlarını `cancelled` yapar; değişiklik olduysa true. */
  private markInterruptedRuns(): boolean {
    let changed = false;
    const now = Date.now();
    for (const run of this.runs) {
      if (run.status !== 'running') continue;
      changed = true;
      run.status = 'cancelled';
      run.finishedAt = now;
      for (const step of run.steps) {
        if (['pending', 'running', 'awaiting-permission'].includes(step.status)) {
          step.status = 'cancelled';
          step.finishedAt = now;
          step.error = RESTART_NOTE;
        }
      }
    }
    return changed;
  }

  private write(name: string, content: string): Promise<void> {
    this.writeChain = this.writeChain
      .then(async () => {
        const target = this.path(name);
        await mkdir(dirname(target), { recursive: true });
        const temp = `${target}.${process.pid}.tmp`;
        await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
        await rename(temp, target);
      })
      .catch((error) => {
        this.deps.logger.warn(`İş akışı: ${name} yazılamadı`, { error: String(error) });
      });
    return this.writeChain;
  }

  private persistWorkflows(): Promise<void> {
    return this.write(
      'workflows.json',
      JSON.stringify({ version: '1', workflows: this.workflows }, null, 2)
    );
  }

  private persistRuns(): Promise<void> {
    this.runs = this.runs.slice(-MAX_STORED_RUNS);
    return this.write(
      'workflow-runs.json',
      JSON.stringify({ version: '1', runs: this.runs }, null, 2)
    );
  }

  // ── Tanımlar ───────────────────────────────────────────────────────────────

  async list(): Promise<WorkflowDefinition[]> {
    await this.ensureLoaded();
    return this.workflows;
  }

  async save(
    workflow: unknown
  ): Promise<{ ok: true; workflow: WorkflowDefinition } | { ok: false; errors: string[] }> {
    await this.ensureLoaded();
    const validated = validateWorkflowDefinition(workflow);
    if (!validated.ok) return validated;
    const index = this.workflows.findIndex((candidate) => candidate.id === validated.workflow.id);
    if (index >= 0) this.workflows[index] = validated.workflow;
    else this.workflows.push(validated.workflow);
    await this.persistWorkflows();
    return validated;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const next = this.workflows.filter((workflow) => workflow.id !== id);
    if (next.length === this.workflows.length) return false;
    this.workflows = next;
    await this.persistWorkflows();
    return true;
  }

  // ── Çalıştırmalar ──────────────────────────────────────────────────────────

  async startRun(input: {
    projectId: string;
    taskId: string;
    workflowId: string;
    input: string;
    autoApprove: boolean;
    maxConcurrency: number;
  }): Promise<{ ok: true; run: WorkflowRun } | { ok: false; errors: string[] }> {
    await this.ensureLoaded();
    const workflow = this.workflows.find((candidate) => candidate.id === input.workflowId);
    if (!workflow) return { ok: false, errors: ['İş akışı bulunamadı.'] };
    // Kayıtlı tanım da yeniden doğrulanır: dosya elle düzenlenmiş olabilir.
    const validated = validateWorkflowDefinition(workflow);
    if (!validated.ok) return validated;
    const run = createWorkflowRun({
      id: randomUUID(),
      workflow: validated.workflow,
      projectId: input.projectId,
      taskId: input.taskId,
      input: input.input,
      autoApprove: input.autoApprove,
      maxConcurrency: Math.min(WORKFLOW_MAX_CONCURRENCY, Math.max(1, input.maxConcurrency)),
      now: Date.now(),
    });
    this.runs.push(run);
    const controller = new AbortController();
    const runner = new WorkflowRunner({
      port: this.deps.createPort({ projectId: input.projectId, taskId: input.taskId }),
      logger: this.deps.logger,
      ...(this.deps.stepTimeoutMs ? { stepTimeoutMs: this.deps.stepTimeoutMs } : {}),
      onChange: () => void this.persistRuns(),
    });
    const done = runner
      .execute(validated.workflow, run, controller.signal)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.deps.logger.warn('İş akışı: çalıştırma beklenmedik şekilde bitti', {
          run: run.id,
          error: String(error),
        });
        run.status = 'failed';
        run.finishedAt = Date.now();
        for (const step of run.steps) {
          if (step.status === 'pending') step.status = 'skipped';
        }
      })
      .finally(() => {
        this.active.delete(run.id);
        void this.persistRuns();
      });
    this.active.set(run.id, { run, controller, done });
    await this.persistRuns();
    return { ok: true, run: structuredClone(run) };
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    await this.ensureLoaded();
    const run = this.runs.find((candidate) => candidate.id === runId);
    return run ? structuredClone(run) : null;
  }

  async listRuns(taskId?: string): Promise<WorkflowRun[]> {
    await this.ensureLoaded();
    const runs = taskId ? this.runs.filter((run) => run.taskId === taskId) : this.runs;
    return structuredClone(runs);
  }

  async cancelRun(runId: string): Promise<boolean> {
    await this.ensureLoaded();
    const active = this.active.get(runId);
    if (!active) return false;
    active.controller.abort();
    await active.done;
    return true;
  }

  /** Uygulama kapanırken çalışan her şeyi iptal eder ve kaydı yazar. */
  async dispose(): Promise<void> {
    for (const active of this.active.values()) active.controller.abort();
    await Promise.all(Array.from(this.active.values(), (active) => active.done));
    await this.writeChain;
  }
}
