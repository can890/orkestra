// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/workflows/WorkflowEngine.ts,
// apps/server/src/workflows/stepServices.ts, apps/server/src/workflows/workflowAgent.ts
//
// Dayanıklı iş akışı motoru. T3 `effect/workflow` ile yeniden oynatır; burada aynı fikir düz
// async/await ile uygulanır:
// - Her adlı ilkel (step/agent/ask/sleep) sonucu, başarıyla bittiği anda çalıştırma dosyasına
//   yazılır. Gövde her devamda baştan çalışır; tamamlanmış ilkeller kayıtlı değeri döndürür.
// - Bekleme (ask/sleep) ve hata, gövdeyi bir "kesinti" ile durdurur; o anda süren kardeş adımlar
//   bitirilip kaydedildikten sonra çalıştırma `waiting` ya da `paused` olur.
// - Uygulama yeniden başlayınca `running`/`waiting` çalıştırmalar ilk bitmemiş ilkelden sürer.
import { randomUUID } from 'node:crypto';
import type { Logger } from '@orkestra/shared/logger';
import type {
  CodeWorkflowActionResult,
  CodeWorkflowEntry,
  CodeWorkflowRun,
  CodeWorkflowTriggerKind,
} from '../contract';
import {
  parseDuration,
  runInContext,
  runInStep,
  type AgentOptions,
  type AskAnswer,
  type AskOptions,
  type IssuePayload,
  type PollTrigger,
  type PullRequestPayload,
  type RunContext,
  type SchemaLike,
  type StepOptions,
  type StepWork,
  type WebhookRequest,
  type WorkflowDefinition,
} from './authoring';
import { emptyEngineState, type EngineState, type WorkflowRunStore } from './store';
import {
  HookRateLimiter,
  isMissedRun,
  nextScheduledAt,
  verifyWebhookSignature,
  webhookDeliveryKey,
} from './triggers';

// ── Ajan adımı portu ────────────────────────────────────────────────────────

export type AgentStepRequest = {
  runId: string;
  workflow: string;
  step: string;
  attempt: number;
  task: string | null;
  conversation: string | null;
  provider: string | null;
  model: string | null;
  brief: string;
  title: string;
  autoApprove: boolean;
  timeoutMs: number | null;
  signal: AbortSignal;
  onConversation(info: { conversationId: string; projectId: string; taskId: string }): void;
};

export type AgentStepOutcome =
  | { status: 'done'; report: string; conversationId: string }
  | {
      status: 'failed';
      message: string;
      /** Ajan çalıştı ve vazgeçti/zaman aşımına uğradı (true) ya da hiç başlatılamadı (false). */
      started: boolean;
      /** Tur yarıda kesildiyse (oturum öldü) bir kez yeni sohbetle denenir. */
      retryable: boolean;
      conversationId: string | null;
    };

/** Ajan adımlarını gerçek Orkestra sohbetlerinde yürüten port; testler sahtesini verir. */
export type AgentStepExecutor = {
  run(request: AgentStepRequest): Promise<AgentStepOutcome>;
  followUp(request: {
    conversationId: string;
    text: string;
    signal: AbortSignal;
    timeoutMs: number | null;
    autoApprove: boolean;
  }): Promise<AgentStepOutcome>;
};

export type PollSources = {
  issues(trigger: PollTrigger): Promise<IssuePayload[]>;
  pullRequests(trigger: PollTrigger): Promise<PullRequestPayload[]>;
};

export type LoadedDefinition = { definition: WorkflowDefinition; file: string };

export type WorkflowEngineOptions = {
  store: WorkflowRunStore;
  agents: AgentStepExecutor;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
  pollSources?: PollSources;
  /** `ask` açıldığında (bildirim için). */
  onQuestion?: (run: CodeWorkflowRun, entry: CodeWorkflowEntry) => void;
  onRunChanged?: (run: CodeWorkflowRun) => void;
  /** Zamanlayıcıların otomatik işlemesi; testler `tick()`i elle çağırır. */
  autoTick?: boolean;
  tickMs?: number;
  pollMs?: number;
};

const MAX_ENDED_RUNS = 500;
const MAX_SEEN_PER_POLL = 2000;
const MAX_TITLE = 200;
const AGENT_RETURN_CORRECTIONS = 2;

const RETURNS_INSTRUCTIONS =
  '\n\nWhen you are done, end your final message with the result as one fenced ```json code block that matches what this step asks for. Put nothing after the block.';

// ── Kesintiler ──────────────────────────────────────────────────────────────

type InterruptKind = 'suspend' | 'pause' | 'end' | 'failure' | 'abort';

class Interrupt extends Error {
  constructor(
    readonly kind: InterruptKind,
    message: string,
    readonly detail: {
      end?: 'stopped' | 'skipped';
      failure?: 'step' | 'agent';
    } = {}
  ) {
    super(message);
    this.name = 'WorkflowInterrupt';
  }
}

const PRIORITY: Record<InterruptKind, number> = {
  abort: 5,
  failure: 4,
  pause: 3,
  end: 2,
  suspend: 1,
};

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : (JSON.stringify(error) ?? String(error));
}

function jsonClone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Ajanın son mesajındaki son ```json bloğunu (yoksa tüm metni) okur. */
export function extractJsonResult(report: string): { ok: true; value: unknown } | { ok: false } {
  const blocks = [...report.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidates = [blocks.at(-1)?.[1], report.trim()].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== ''
  );
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // Sıradaki aday denenir.
    }
  }
  return { ok: false };
}

function schemaProblem(error: unknown): string {
  const issues = (error as { issues?: { path?: unknown[]; message?: string }[] })?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .slice(0, 5)
      .map((issue) => `${(issue.path ?? []).join('.') || '(root)'}: ${issue.message ?? 'invalid'}`)
      .join('; ');
  }
  return describe(error);
}

// ── Motor ───────────────────────────────────────────────────────────────────

type Execution = {
  promise: Promise<void>;
  controller: AbortController;
  pauseRequested: boolean;
  again: boolean;
};

export class WorkflowEngine {
  private readonly runs = new Map<string, CodeWorkflowRun>();
  private readonly keys = new Map<string, string>();
  private readonly executions = new Map<string, Execution>();
  private definitions: LoadedDefinition[] = [];
  private state: EngineState = emptyEngineState();
  private started = false;
  private disposed = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private polling: Promise<void> | null = null;
  private readonly limiter = new HookRateLimiter();
  private readonly now: () => number;

  constructor(private readonly options: WorkflowEngineOptions) {
    this.now = options.now ?? Date.now;
  }

  // ── Yaşam döngüsü ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.state = await this.options.store.loadState();
    const runs = await this.options.store.loadRuns();
    const ended = runs.filter((run) => !this.isActive(run));
    const drop = ended.slice(0, Math.max(0, ended.length - MAX_ENDED_RUNS));
    for (const run of drop) void this.options.store.deleteRun(run.id);
    const dropped = new Set(drop.map((run) => run.id));
    for (const run of runs) {
      if (dropped.has(run.id)) continue;
      this.runs.set(run.id, run);
      this.keys.set(this.keyOf(run.workflow, run.key), run.id);
    }
    // Uygulama kapanırken süren çalıştırmalar ilk bitmemiş ilkelden devam eder.
    for (const run of this.runs.values()) {
      if (run.status === 'running') this.schedule(run.id);
    }
    if (this.options.autoTick !== false) {
      this.tickTimer = setInterval(() => void this.tick(), this.options.tickMs ?? 15_000);
      this.pollTimer = setInterval(() => void this.poll(), this.options.pollMs ?? 60_000);
      this.tickTimer.unref?.();
      this.pollTimer.unref?.();
      void this.tick();
    }
  }

  /**
   * Motoru durdurur (uygulama kapanışı). Süren çalıştırmalar diskte oldukları gibi kalır ve
   * bir sonraki başlatmada sürer; ajan turları iptal edilmez.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    const executions = [...this.executions.values()];
    for (const execution of executions) execution.controller.abort('shutdown');
    await Promise.allSettled(executions.map((execution) => execution.promise));
    await this.options.store.flush();
  }

  /** Çalıştırmanın o anki yürütmesi bitene kadar bekler (testler ve iptal için). */
  async settled(runId: string): Promise<void> {
    for (;;) {
      const execution = this.executions.get(runId);
      if (!execution) return;
      await execution.promise;
    }
  }

  // ── Tanımlar ──────────────────────────────────────────────────────────────

  setDefinitions(definitions: LoadedDefinition[]): void {
    this.definitions = definitions;
    // Sürümü yeniden yüklenen emekli çalıştırmalar kendiliğinden sürer.
    for (const run of this.runs.values()) {
      if (
        run.status === 'paused' &&
        run.pauseKind === 'retired' &&
        this.definition(run.workflow, run.version)
      ) {
        run.status = 'running';
        run.pauseKind = null;
        run.error = null;
        void this.save(run);
        this.schedule(run.id);
      }
    }
    if (this.started && this.options.autoTick !== false) void this.tick();
  }

  listDefinitions(): LoadedDefinition[] {
    return this.definitions;
  }

  private definition(name: string, version: number): WorkflowDefinition | null {
    return (
      this.definitions.find(
        (entry) => entry.definition.name === name && entry.definition.version === version
      )?.definition ?? null
    );
  }

  /** Her adın en yüksek sürümü: elle ve tetikleyiciyle başlatılan sürüm. */
  latestDefinitions(): LoadedDefinition[] {
    const latest = new Map<string, LoadedDefinition>();
    for (const entry of this.definitions) {
      const current = latest.get(entry.definition.name);
      if (!current || current.definition.version < entry.definition.version) {
        latest.set(entry.definition.name, entry);
      }
    }
    return [...latest.values()];
  }

  nextScheduleAt(workflow: string, triggerId: string): number | null {
    return this.state.schedules[`${workflow}|${triggerId}`] ?? null;
  }

  // ── Okuma ─────────────────────────────────────────────────────────────────

  listRuns(limit = 200): CodeWorkflowRun[] {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((run) => structuredClone(run));
  }

  getRun(runId: string): CodeWorkflowRun | null {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : null;
  }

  // ── Başlatma ──────────────────────────────────────────────────────────────

  async startRun(
    workflow: string,
    payload: unknown,
    options: { key?: string; trigger?: { kind: CodeWorkflowTriggerKind; detail?: string } } = {}
  ): Promise<{ ok: true; runId: string; existing: boolean } | { ok: false; error: string }> {
    if (this.disposed) return { ok: false, error: 'Workflows are stopped.' };
    const loaded = this.latestDefinitions().find((entry) => entry.definition.name === workflow);
    if (!loaded) return { ok: false, error: `No workflow named "${workflow}" is loaded.` };
    const key = options.key?.trim() || randomUUID();
    const existing = this.keys.get(this.keyOf(workflow, key));
    if (existing) return { ok: true, runId: existing, existing: true };
    const definition = loaded.definition;
    let value = payload;
    if (definition.payload) {
      const parsed = definition.payload.safeParse(payload);
      if (!parsed.success) {
        return {
          ok: false,
          error: `The input does not fit workflow "${workflow}": ${schemaProblem(parsed.error)}`,
        };
      }
      value = parsed.data;
    }
    try {
      value = jsonClone(value ?? null);
    } catch (error) {
      return { ok: false, error: `The input is not JSON: ${describe(error)}` };
    }
    const now = this.now();
    const run: CodeWorkflowRun = {
      id: randomUUID(),
      workflow,
      version: definition.version,
      key,
      title: null,
      status: 'running',
      payload: value,
      trigger: { kind: options.trigger?.kind ?? 'manual', detail: options.trigger?.detail ?? null },
      createdAt: now,
      updatedAt: now,
      endedAt: null,
      reason: null,
      error: null,
      pauseKind: null,
      autoResumeCount: 0,
      nextResumeAt: null,
      entries: [],
    };
    this.runs.set(run.id, run);
    this.keys.set(this.keyOf(workflow, key), run.id);
    await this.save(run);
    this.schedule(run.id);
    return { ok: true, runId: run.id, existing: false };
  }

  // ── Kullanıcı eylemleri ───────────────────────────────────────────────────

  async answer(
    runId: string,
    name: string,
    choice: string,
    reason?: string
  ): Promise<CodeWorkflowActionResult> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: 'Run not found.' };
    const entry = run.entries.find((candidate) => candidate.name === name);
    if (!entry || entry.kind !== 'ask' || entry.status !== 'waiting' || !entry.question) {
      return { ok: false, error: 'This question is no longer open.' };
    }
    if (!entry.question.choices.includes(choice)) {
      return { ok: false, error: `"${choice}" is not one of the choices.` };
    }
    entry.status = 'completed';
    entry.endedAt = this.now();
    entry.value = reason?.trim() ? { choice, reason: reason.trim() } : { choice };
    await this.save(run);
    if (run.status === 'waiting') this.schedule(run.id);
    return { ok: true };
  }

  async pause(runId: string): Promise<CodeWorkflowActionResult> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: 'Run not found.' };
    if (run.status === 'running') {
      const execution = this.executions.get(runId);
      if (execution) {
        // Süren adımlar biter ve kaydedilir; yeni adım başlamaz.
        execution.pauseRequested = true;
        return { ok: true };
      }
    }
    if (run.status !== 'running' && run.status !== 'waiting') {
      return { ok: false, error: `A ${run.status} run cannot be paused.` };
    }
    run.status = 'paused';
    run.pauseKind = 'user';
    run.reason = 'Paused by you.';
    run.nextResumeAt = null;
    await this.save(run);
    return { ok: true };
  }

  /** Duraklatılmış çalıştırmayı sürdürür; başarısız adım (yalnızca o) yeniden çalışır. */
  async resume(runId: string): Promise<CodeWorkflowActionResult> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: 'Run not found.' };
    const execution = this.executions.get(runId);
    if (run.status === 'running' && execution?.pauseRequested) {
      execution.pauseRequested = false;
      return { ok: true };
    }
    if (run.status === 'waiting') {
      this.schedule(run.id);
      return { ok: true };
    }
    if (run.status !== 'paused')
      return { ok: false, error: `A ${run.status} run cannot be resumed.` };
    if (run.pauseKind === 'retired' && !this.definition(run.workflow, run.version)) {
      return {
        ok: false,
        error: `Version ${run.version} of "${run.workflow}" is not loaded. Restore it to continue this run.`,
      };
    }
    run.status = 'running';
    run.pauseKind = null;
    run.error = null;
    run.reason = null;
    run.nextResumeAt = null;
    run.autoResumeCount = 0;
    await this.save(run);
    this.schedule(run.id);
    return { ok: true };
  }

  async cancel(runId: string, reason?: string): Promise<CodeWorkflowActionResult> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: 'Run not found.' };
    if (!this.isActive(run))
      return { ok: false, error: `A ${run.status} run cannot be cancelled.` };
    const now = this.now();
    run.status = 'cancelled';
    run.reason = reason?.trim() || 'Cancelled by you.';
    run.endedAt = now;
    run.nextResumeAt = null;
    for (const entry of run.entries) {
      if (entry.status === 'running' || entry.status === 'waiting') {
        entry.status = 'cancelled';
        entry.endedAt = now;
      }
    }
    await this.save(run);
    // Süren ajan turları iptal edilir.
    this.executions.get(runId)?.controller.abort('cancel');
    await this.settled(runId);
    return { ok: true };
  }

  // ── Zamanlayıcı ───────────────────────────────────────────────────────────

  /** Uyandırmaları, zaman aşımlarını, kendiliğinden devamları ve zamanlamaları işler. */
  tick(): Promise<void> {
    this.ticking ??= this.tickOnce().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async tickOnce(): Promise<void> {
    if (this.disposed) return;
    const now = this.now();
    for (const run of this.runs.values()) {
      if (run.status === 'waiting' && this.dueWake(run) <= now) this.schedule(run.id);
      if (run.status === 'paused' && run.nextResumeAt !== null && run.nextResumeAt <= now) {
        run.status = 'running';
        run.pauseKind = null;
        run.error = null;
        run.nextResumeAt = null;
        run.autoResumeCount += 1;
        await this.save(run);
        this.schedule(run.id);
      }
    }
    await this.fireSchedules(now);
  }

  private dueWake(run: CodeWorkflowRun): number {
    let due = Number.POSITIVE_INFINITY;
    for (const entry of run.entries) {
      if (entry.status !== 'waiting') continue;
      if (entry.kind === 'sleep' && entry.wakeAt !== undefined) due = Math.min(due, entry.wakeAt);
      if (entry.kind === 'ask' && entry.question?.timeoutAt != null) {
        due = Math.min(due, entry.question.timeoutAt);
      }
    }
    return due;
  }

  private async fireSchedules(now: number): Promise<void> {
    const live = new Set<string>();
    const loaded = new Set(this.latestDefinitions().map((entry) => entry.definition.name));
    let changed = false;
    for (const { definition } of this.latestDefinitions()) {
      for (const trigger of definition.triggers) {
        if (trigger.kind !== 'schedule') continue;
        const id = `${definition.name}|${trigger.id}`;
        live.add(id);
        const dueAt = this.state.schedules[id];
        if (dueAt === undefined) {
          // İlk çalıştırma yüklemeden bir aralık sonra gelir.
          const next = nextScheduledAt(trigger.schedule, now);
          if (next !== null) this.state.schedules[id] = next;
          changed = true;
          continue;
        }
        if (dueAt > now) continue;
        if (!isMissedRun(trigger.schedule, dueAt, now)) {
          const started = await this.startRun(
            definition.name,
            { scheduledAt: new Date(dueAt).toISOString() },
            {
              key: `schedule:${trigger.id}:${dueAt}`,
              trigger: { kind: 'schedule', detail: trigger.id },
            }
          );
          if (!started.ok) {
            this.options.logger.warn('Workflows: scheduled run did not start', {
              workflow: definition.name,
              error: started.error,
            });
          }
        }
        // Kapalı kalınan süre tek çalıştırmaya iner.
        const next = nextScheduledAt(trigger.schedule, now);
        if (next === null) delete this.state.schedules[id];
        else this.state.schedules[id] = next;
        changed = true;
      }
    }
    // Yalnızca yüklü iş akışlarının kaldırılan tetikleyicileri unutulur; henüz yüklenmemiş bir
    // dosyanın zamanı korunur ki kapalıyken kaçan çalıştırma tek seferde gelsin.
    for (const id of Object.keys(this.state.schedules)) {
      if (!live.has(id) && loaded.has(id.slice(0, id.indexOf('|')))) {
        delete this.state.schedules[id];
        changed = true;
      }
    }
    if (changed) await this.options.store.saveState(this.state);
  }

  // ── Yoklama tetikleyicileri (issue / PR) ──────────────────────────────────

  poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    const sources = this.options.pollSources;
    if (!sources || this.disposed) return;
    let changed = false;
    for (const { definition } of this.latestDefinitions()) {
      for (const trigger of definition.triggers) {
        if (trigger.kind !== 'issues' && trigger.kind !== 'pull-requests') continue;
        const id = `${definition.name}|${trigger.id}`;
        let items: (IssuePayload | PullRequestPayload)[];
        try {
          items =
            trigger.kind === 'issues'
              ? await sources.issues(trigger)
              : await sources.pullRequests(trigger);
        } catch (error) {
          this.options.logger.warn('Workflows: could not look for new items', {
            workflow: definition.name,
            error: describe(error),
          });
          continue;
        }
        const seen = this.state.polls[id];
        const ids = items.map((item) => item.url || item.identifier);
        if (!seen) {
          // Yalnızca iş akışı ilk yüklendikten sonra açılanlar çalıştırma başlatır.
          this.state.polls[id] = ids.slice(0, MAX_SEEN_PER_POLL);
          changed = true;
          continue;
        }
        const known = new Set(seen);
        for (const [index, item] of items.entries()) {
          const itemId = ids[index]!;
          if (known.has(itemId)) continue;
          known.add(itemId);
          seen.unshift(itemId);
          changed = true;
          const kind = trigger.kind === 'issues' ? 'issue' : 'pull-request';
          const started = await this.startRun(definition.name, item, {
            key: `${kind}:${itemId}`,
            trigger: { kind, detail: item.url || item.identifier },
          });
          if (!started.ok) {
            this.options.logger.warn('Workflows: run for a new item did not start', {
              workflow: definition.name,
              error: started.error,
            });
          }
        }
        if (seen.length > MAX_SEEN_PER_POLL) seen.length = MAX_SEEN_PER_POLL;
      }
    }
    if (changed) await this.options.store.saveState(this.state);
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  /** Doğrulanmış (yolu gizli belirteci içeren) bir kanca isteğini karşılar. */
  async handleWebhook(input: {
    workflow: string;
    hook: string;
    request: WebhookRequest;
    secret: string;
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    const loaded = this.latestDefinitions().find(
      (entry) => entry.definition.name === input.workflow
    );
    const trigger = loaded?.definition.triggers.find(
      (candidate) => candidate.kind === 'webhook' && candidate.name === input.hook
    );
    if (!loaded || !trigger || trigger.kind !== 'webhook') {
      return { status: 404, body: { error: 'Not found' } };
    }
    if (
      trigger.signature &&
      !verifyWebhookSignature({
        signature: trigger.signature,
        secret: input.secret,
        headers: input.request.headers,
        body: input.request.body,
      })
    ) {
      return { status: 401, body: { error: 'Invalid signature' } };
    }
    let delivery: string | null;
    try {
      delivery = webhookDeliveryKey(input.request, trigger.key);
    } catch (error) {
      return { status: 400, body: { error: `The hook's key failed: ${describe(error)}` } };
    }
    const key = delivery ? `webhook:${input.hook}:${delivery}` : undefined;
    if (key && this.keys.has(this.keyOf(input.workflow, key))) {
      return {
        status: 200,
        body: {
          accepted: true,
          duplicate: true,
          runId: this.keys.get(this.keyOf(input.workflow, key)),
        },
      };
    }
    if (!this.limiter.take(`${input.workflow}/${input.hook}`, this.now())) {
      return { status: 429, body: { error: 'Too many requests; try again in a minute.' } };
    }
    const started = await this.startRun(input.workflow, input.request, {
      ...(key ? { key } : {}),
      trigger: { kind: 'webhook', detail: input.hook },
    });
    if (!started.ok) return { status: 422, body: { error: started.error } };
    return { status: started.existing ? 200 : 202, body: { accepted: true, runId: started.runId } };
  }

  // ── Yürütme ───────────────────────────────────────────────────────────────

  private isActive(run: CodeWorkflowRun): boolean {
    return run.status === 'running' || run.status === 'waiting' || run.status === 'paused';
  }

  private keyOf(workflow: string, key: string): string {
    return `${workflow}\u0000${key}`;
  }

  private async save(run: CodeWorkflowRun): Promise<void> {
    run.updatedAt = this.now();
    await this.options.store.saveRun(run);
    this.options.onRunChanged?.(run);
  }

  private schedule(runId: string): void {
    if (this.disposed) return;
    const current = this.executions.get(runId);
    if (current) {
      current.again = true;
      return;
    }
    const run = this.runs.get(runId);
    if (!run || (run.status !== 'running' && run.status !== 'waiting')) return;
    const execution: Execution = {
      controller: new AbortController(),
      pauseRequested: false,
      again: false,
      promise: Promise.resolve(),
    };
    this.executions.set(runId, execution);
    execution.promise = this.execute(run, execution)
      .catch((error: unknown) => {
        this.options.logger.warn('Workflows: run execution failed unexpectedly', {
          run: runId,
          error: describe(error),
        });
      })
      .finally(() => {
        this.executions.delete(runId);
        if (execution.again && !this.disposed) this.schedule(runId);
      });
  }

  private async execute(run: CodeWorkflowRun, execution: Execution): Promise<void> {
    const definition = this.definition(run.workflow, run.version);
    if (!definition) {
      run.status = 'paused';
      run.pauseKind = 'retired';
      run.error = `Version ${run.version} of "${run.workflow}" is not loaded. Restore it (or cancel this run).`;
      await this.save(run);
      return;
    }
    if (run.status !== 'running') {
      run.status = 'running';
      await this.save(run);
    }
    const body = new BodyExecution(run, definition, execution, {
      agents: this.options.agents,
      now: this.now,
      save: (target) => this.save(target),
      onQuestion: (target, entry) => this.options.onQuestion?.(target, entry),
    });
    const outcome = await body.go();
    // Kapanışta çalıştırma diskte olduğu gibi kalır; sonraki başlatmada sürer.
    if (this.disposed || execution.controller.signal.reason === 'shutdown') return;
    // İptal, gövde çalışırken durumu değiştirmiş olabilir (TS daraltmasını aşmak için okunur).
    if ((run.status as CodeWorkflowRun['status']) === 'cancelled') return;
    await this.finish(run, definition, outcome);
  }

  private async finish(
    run: CodeWorkflowRun,
    definition: WorkflowDefinition,
    outcome: BodyOutcome
  ): Promise<void> {
    const now = this.now();
    run.nextResumeAt = null;
    switch (outcome.kind) {
      case 'completed':
        run.status = 'completed';
        run.result = outcome.value;
        run.endedAt = now;
        run.reason = null;
        run.error = null;
        run.pauseKind = null;
        break;
      case 'ended':
        run.status = outcome.end;
        run.reason = outcome.reason;
        run.endedAt = now;
        run.error = null;
        run.pauseKind = null;
        break;
      case 'waiting':
        run.status = 'waiting';
        break;
      case 'paused-by-user':
        run.status = 'paused';
        run.pauseKind = 'user';
        run.reason = 'Paused by you.';
        break;
      case 'failed': {
        run.status = 'paused';
        run.pauseKind = outcome.pauseKind;
        run.error = outcome.error;
        run.reason = null;
        // Ajan vazgeçtiyse kişi bekler; kod hataları `resumeAfter` ile kendiliğinden sürer.
        const delayMs =
          outcome.pauseKind === 'agent' ? undefined : definition.resumeAfterMs[run.autoResumeCount];
        run.nextResumeAt = delayMs === undefined ? null : now + delayMs;
        break;
      }
    }
    await this.save(run);
  }
}

// ── Gövde yürütmesi ─────────────────────────────────────────────────────────

type BodyOutcome =
  | { kind: 'completed'; value: unknown }
  | { kind: 'ended'; end: 'stopped' | 'skipped'; reason: string }
  | { kind: 'waiting' }
  | { kind: 'paused-by-user' }
  | { kind: 'failed'; pauseKind: 'step' | 'agent' | 'body'; error: string };

type BodyServices = {
  agents: AgentStepExecutor;
  now: () => number;
  save(run: CodeWorkflowRun): Promise<void>;
  onQuestion(run: CodeWorkflowRun, entry: CodeWorkflowEntry): void;
};

class BodyExecution {
  private readonly names = new Set<string>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly interrupts: Interrupt[] = [];

  constructor(
    private readonly run: CodeWorkflowRun,
    private readonly definition: WorkflowDefinition,
    private readonly execution: Execution,
    private readonly services: BodyServices
  ) {}

  private get signal(): AbortSignal {
    return this.execution.controller.signal;
  }

  async go(): Promise<BodyOutcome> {
    const context = this.context();
    let value: unknown;
    let thrown: unknown = undefined;
    let failed = false;
    try {
      value = await runInContext(context, () =>
        Promise.resolve().then(() =>
          this.definition.body(jsonClone(this.run.payload), { id: this.run.id })
        )
      );
    } catch (error) {
      failed = true;
      thrown = error;
    }
    // Kardeş adımlar biter ve kaydedilir; biten iş kaybolmaz.
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
    if (failed && thrown instanceof Interrupt) this.record(thrown);
    const interrupt = this.strongest();
    if (interrupt) {
      switch (interrupt.kind) {
        case 'abort':
          return { kind: 'waiting' };
        case 'failure':
          return {
            kind: 'failed',
            pauseKind: interrupt.detail.failure ?? 'step',
            error: interrupt.message,
          };
        case 'pause':
          return { kind: 'paused-by-user' };
        case 'end':
          return {
            kind: 'ended',
            end: interrupt.detail.end ?? 'stopped',
            reason: interrupt.message,
          };
        case 'suspend':
          return this.execution.pauseRequested ? { kind: 'paused-by-user' } : { kind: 'waiting' };
      }
    }
    if (failed) return { kind: 'failed', pauseKind: 'body', error: describe(thrown) };
    // Gövde bittiyse geç kalan duraklatma isteği yok sayılır; sonuç geçerlidir.
    try {
      return {
        kind: 'completed',
        value: this.toJson(value, this.definition.returns, 'The workflow'),
      };
    } catch (error) {
      return { kind: 'failed', pauseKind: 'body', error: describe(error) };
    }
  }

  private record(interrupt: Interrupt): void {
    if (!this.interrupts.includes(interrupt)) this.interrupts.push(interrupt);
  }

  private strongest(): Interrupt | null {
    let best: Interrupt | null = null;
    for (const interrupt of this.interrupts) {
      if (!best || PRIORITY[interrupt.kind] > PRIORITY[best.kind]) best = interrupt;
    }
    return best;
  }

  /** Kesinti varsa ya da duraklatma istendiyse yeni ilkel başlamaz. */
  private gate(): void {
    if (this.signal.aborted) throw this.interrupt('abort', 'The run was stopped.');
    const existing = this.strongest();
    if (existing) throw existing;
    if (this.execution.pauseRequested) throw this.interrupt('pause', 'Paused by you.');
  }

  private interrupt(kind: InterruptKind, message: string, detail?: Interrupt['detail']): Interrupt {
    const interrupt = new Interrupt(kind, message, detail);
    this.record(interrupt);
    return interrupt;
  }

  private claim(name: string): void {
    if (this.names.has(name)) {
      throw new Error(
        `Two calls in this run are named "${name}". Every step, agent, ask and sleep needs its own name (use \`name-\${i}\` in loops).`
      );
    }
    this.names.add(name);
  }

  private entry(name: string, kind: CodeWorkflowEntry['kind']): CodeWorkflowEntry | undefined {
    const entry = this.run.entries.find((candidate) => candidate.name === name);
    if (entry && entry.kind !== kind) {
      throw new Error(
        `"${name}" was a ${entry.kind} in this run and is now a ${kind}. Raise the workflow's version when you change its steps.`
      );
    }
    return entry;
  }

  private begin(name: string, kind: CodeWorkflowEntry['kind'], existing?: CodeWorkflowEntry) {
    const now = this.services.now();
    if (existing) {
      existing.status = 'running';
      existing.attempts += 1;
      existing.error = null;
      existing.endedAt = null;
      return existing;
    }
    const entry: CodeWorkflowEntry = {
      name,
      kind,
      status: 'running',
      attempts: 1,
      startedAt: now,
      endedAt: null,
      error: null,
    };
    this.run.entries.push(entry);
    return entry;
  }

  private track<T>(work: () => Promise<T>): Promise<T> {
    const promise = work();
    this.inflight.add(promise);
    // Gövde beklemese bile işlenmemiş ret oluşmasın.
    promise.catch(() => undefined).finally(() => this.inflight.delete(promise));
    return promise;
  }

  private toJson(value: unknown, schema: SchemaLike | null, where: string): unknown {
    let data = value;
    if (schema) {
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw new Error(
          `${where} returned data that does not fit its schema: ${schemaProblem(parsed.error)}`
        );
      }
      data = parsed.data;
    }
    try {
      return jsonClone(data);
    } catch (error) {
      throw new Error(`${where} returned something that is not JSON: ${describe(error)}`);
    }
  }

  private async complete(entry: CodeWorkflowEntry, value: unknown, error: string | null = null) {
    entry.status = 'completed';
    entry.value = value;
    entry.error = error;
    entry.endedAt = this.services.now();
    await this.services.save(this.run);
  }

  private async fail(entry: CodeWorkflowEntry, error: string) {
    entry.status = 'failed';
    entry.error = error;
    entry.endedAt = this.services.now();
    await this.services.save(this.run);
  }

  private context(): RunContext {
    return {
      step: (name, work, options, tryMode) => this.step(name, work, options, tryMode),
      agent: (name, options, tryMode) => this.agent(name, options, tryMode),
      ask: (name, options) => this.ask(name, options),
      sleep: (name, duration) => this.sleep(name, duration),
      title: (text) => this.title(text),
      end: (kind, reason) => {
        throw this.interrupt('end', reason, { end: kind });
      },
    };
  }

  private title(text: string): void {
    const next = text.slice(0, MAX_TITLE);
    if (this.run.title !== next) {
      this.run.title = next;
      void this.services.save(this.run);
    }
  }

  // ── step ──────────────────────────────────────────────────────────────────

  private async step(
    name: string,
    work: StepWork,
    options: StepOptions | undefined,
    tryMode: boolean
  ): Promise<unknown> {
    this.claim(name);
    this.gate();
    const existing = this.entry(name, 'step');
    if (existing?.status === 'completed') return jsonClone(existing.value);
    const entry = this.begin(name, 'step', existing);
    await this.services.save(this.run);
    const times = Math.max(0, Math.floor(options?.retry?.times ?? 0));
    const retryDelay =
      options?.retry?.delay === undefined
        ? null
        : parseDuration(options.retry.delay, `step("${name}") retry.delay`);
    return this.track(async () => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= times; attempt += 1) {
        if (this.signal.aborted) throw this.interrupt('abort', 'The run was stopped.');
        try {
          const raw = await runInStep(this.context(), () => work({ signal: this.signal, attempt }));
          if (this.signal.aborted) throw this.interrupt('abort', 'The run was stopped.');
          const value = this.toJson(raw, options?.returns ?? null, `step("${name}")`);
          const result = tryMode ? { outcome: 'done', value } : value;
          await this.complete(entry, result);
          return jsonClone(result);
        } catch (error) {
          if (error instanceof Interrupt && error.kind === 'abort') throw error;
          if (this.signal.aborted) throw this.interrupt('abort', 'The run was stopped.');
          lastError = error;
          if (attempt < times) await delay(retryDelay ?? 1000 * 2 ** attempt, this.signal);
        }
      }
      const message = describe(lastError);
      if (tryMode) {
        const result = { outcome: 'failed', reason: message };
        await this.complete(entry, result, message);
        return jsonClone(result);
      }
      await this.fail(entry, message);
      throw this.interrupt('failure', `Step "${name}" failed: ${message}`, { failure: 'step' });
    });
  }

  // ── agent ─────────────────────────────────────────────────────────────────

  private async agent(name: string, options: AgentOptions, tryMode: boolean): Promise<unknown> {
    this.claim(name);
    this.gate();
    const existing = this.entry(name, 'agent');
    if (existing?.status === 'completed') return jsonClone(existing.value);
    const timeoutMs =
      options.timeout === undefined
        ? null
        : parseDuration(options.timeout, `agent("${name}") timeout`);
    const entry = this.begin(name, 'agent', existing);
    entry.agent = {
      provider: options.provider ?? entry.agent?.provider ?? null,
      model: options.model ?? entry.agent?.model ?? null,
      projectId: entry.agent?.projectId ?? null,
      taskId: options.task ?? entry.agent?.taskId ?? null,
      conversationId: null,
      conversations: entry.agent?.conversations ?? [],
    };
    await this.services.save(this.run);
    const autoApprove = options.autoApprove === true;
    const brief = options.returns ? `${options.brief}${RETURNS_INSTRUCTIONS}` : options.brief;
    return this.track(async () => {
      const request = (attempt: number) => ({
        runId: this.run.id,
        workflow: this.run.workflow,
        step: name,
        attempt,
        task: options.task ?? null,
        conversation: options.conversation ?? null,
        provider: options.provider ?? null,
        model: options.model ?? null,
        brief,
        title: options.title?.trim() || `${this.run.workflow}: ${name}`,
        autoApprove,
        timeoutMs,
        signal: this.signal,
        onConversation: (info: { conversationId: string; projectId: string; taskId: string }) => {
          const agentInfo = entry.agent!;
          agentInfo.conversationId = info.conversationId;
          agentInfo.projectId = info.projectId;
          agentInfo.taskId = info.taskId;
          if (!agentInfo.conversations.includes(info.conversationId)) {
            agentInfo.conversations.push(info.conversationId);
          }
          void this.services.save(this.run);
        },
      });
      let outcome = await this.services.agents.run(request(entry.attempts));
      if (this.signal.aborted) throw this.interrupt('abort', 'The run was stopped.');
      // Ölen tur bir kez yeni bir sohbetle (devam ediliyorsa aynı sohbetle) yeniden denenir.
      if (outcome.status === 'failed' && outcome.retryable) {
        outcome = await this.services.agents.run(request(entry.attempts + 1));
        if (this.signal.aborted) throw this.interrupt('abort', 'The run was stopped.');
      }
      let value: unknown = undefined;
      let failure: string | null = outcome.status === 'failed' ? outcome.message : null;
      let started = outcome.status === 'done' || outcome.started;
      let conversationId = outcome.conversationId;
      if (outcome.status === 'done') {
        if (!options.returns) {
          value = outcome.report;
        } else {
          let report = outcome.report;
          for (let correction = 0; ; correction += 1) {
            const checked = this.checkReturns(report, options.returns);
            if (checked.ok) {
              value = checked.value;
              break;
            }
            if (correction >= AGENT_RETURN_CORRECTIONS) {
              failure = `The agent did not return valid data: ${checked.problem}`;
              break;
            }
            const next = await this.services.agents.followUp({
              conversationId: outcome.conversationId,
              text: `Your result did not fit what this step needs (${checked.problem}). Reply with only the corrected result as one fenced \`\`\`json code block.`,
              signal: this.signal,
              timeoutMs,
              autoApprove,
            });
            if (this.signal.aborted) throw this.interrupt('abort', 'The run was stopped.');
            if (next.status === 'failed') {
              failure = next.message;
              started = true;
              break;
            }
            report = next.report;
            conversationId = next.conversationId;
          }
        }
      }
      if (failure === null) {
        const result = tryMode
          ? { outcome: 'done', value, conversation: conversationId }
          : { value, conversation: conversationId };
        await this.complete(entry, jsonClone(result));
        return jsonClone(result);
      }
      if (tryMode) {
        const result = { outcome: 'failed', reason: failure, conversation: conversationId };
        await this.complete(entry, result, failure);
        return jsonClone(result);
      }
      await this.fail(entry, failure);
      throw this.interrupt('failure', `Agent step "${name}" failed: ${failure}`, {
        failure: started ? 'agent' : 'step',
      });
    });
  }

  private checkReturns(
    report: string,
    schema: SchemaLike
  ): { ok: true; value: unknown } | { ok: false; problem: string } {
    const extracted = extractJsonResult(report);
    if (!extracted.ok) return { ok: false, problem: 'no JSON result was found' };
    const parsed = schema.safeParse(extracted.value);
    if (!parsed.success) return { ok: false, problem: schemaProblem(parsed.error) };
    try {
      return { ok: true, value: jsonClone(parsed.data) };
    } catch (error) {
      return { ok: false, problem: describe(error) };
    }
  }

  // ── ask / sleep ───────────────────────────────────────────────────────────

  private async ask(name: string, options: AskOptions): Promise<AskAnswer | null> {
    this.claim(name);
    this.gate();
    let entry = this.entry(name, 'ask');
    if (entry?.status === 'completed') return jsonClone(entry.value) as AskAnswer | null;
    const now = this.services.now();
    if (!entry) {
      const timeoutMs =
        options.timeout === undefined
          ? null
          : parseDuration(options.timeout, `ask("${name}") timeout`);
      let data: unknown = undefined;
      try {
        data = jsonClone(options.data);
      } catch (error) {
        throw new Error(`ask("${name}") data is not JSON: ${describe(error)}`);
      }
      entry = {
        name,
        kind: 'ask',
        status: 'waiting',
        attempts: 1,
        startedAt: now,
        endedAt: null,
        error: null,
        question: {
          title: options.title.slice(0, 2000),
          choices: options.choices.map((choice) => choice.slice(0, 200)),
          ...(data === undefined ? {} : { data }),
          timeoutAt: timeoutMs === null ? null : now + timeoutMs,
        },
      };
      this.run.entries.push(entry);
      await this.services.save(this.run);
      this.services.onQuestion(this.run, entry);
    } else if (entry.status !== 'waiting') {
      entry.status = 'waiting';
      await this.services.save(this.run);
    }
    const timeoutAt = entry.question?.timeoutAt ?? null;
    if (timeoutAt !== null && now >= timeoutAt) {
      await this.complete(entry, null);
      return null;
    }
    throw this.interrupt('suspend', `Waiting for an answer to "${name}".`);
  }

  private async sleep(name: string, duration: unknown): Promise<void> {
    this.claim(name);
    this.gate();
    let entry = this.entry(name, 'sleep');
    if (entry?.status === 'completed') return;
    const now = this.services.now();
    if (!entry) {
      entry = {
        name,
        kind: 'sleep',
        status: 'waiting',
        attempts: 1,
        startedAt: now,
        endedAt: null,
        error: null,
        wakeAt: now + parseDuration(duration, `sleep("${name}")`),
      };
      this.run.entries.push(entry);
      await this.services.save(this.run);
    }
    if (now >= (entry.wakeAt ?? 0)) {
      await this.complete(entry, null);
      return;
    }
    throw this.interrupt(
      'suspend',
      `Sleeping until ${new Date(entry.wakeAt ?? now).toISOString()}.`
    );
  }
}
