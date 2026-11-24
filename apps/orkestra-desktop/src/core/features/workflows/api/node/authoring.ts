// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/workflows/workflow.ts,
// apps/server/src/workflows/triggers.ts, apps/server/src/workflows/options.ts
//
// İş akışı dosyalarına `Orkestra` global'i olarak verilen yazım API'si. T3 Effect üreteçleri
// kullanır; Orkestra'da gövde sıradan bir `async` işlevdir ve her ilkel bir Promise döner.
// Dayanıklılık "yeniden oynatma" ile sağlanır: her devamda gövde baştan çalışır, tamamlanmış
// adımlar diskteki değerlerini döndürür.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Cron } from 'croner';
import { z } from 'zod';
import { getLocalTimeZone } from '@core/primitives/automations/api/timezone';

/** `safeParse` sunan herhangi bir şema (zod uyumlu). */
export type SchemaLike<T = unknown> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown };
};

export const DEFAULT_RESUME_AFTER_MS = [5 * 60_000, 20 * 60_000, 80 * 60_000];
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/;

// ── Süreler ─────────────────────────────────────────────────────────────────

const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

/** `"5 minutes"`, `"2 days"`, `"90s"` ya da milisaniye sayısı. */
export function parseDuration(input: unknown, where: string): number {
  if (typeof input === 'number' && Number.isFinite(input) && input >= 0) return input;
  if (typeof input === 'string') {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s*$/.exec(input);
    const unit = match ? UNIT_MS[match[2]!.toLowerCase()] : undefined;
    if (match && unit !== undefined) return Math.round(Number(match[1]) * unit);
  }
  throw new Error(
    `${where}: cannot read duration ${JSON.stringify(input)}. Use a number of milliseconds or text such as "30 seconds", "5 minutes", "2 hours", "1 day".`
  );
}

/** Seçenek nesnesindeki bilinmeyen alanları reddeder: iş akışı dosyaları tür denetiminden geçmez. */
export function checkOptions(where: string, options: unknown, allowed: readonly string[]): void {
  if (options === undefined) return;
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error(`${where}: options must be an object.`);
  }
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `${where} does not take ${unknown.map((key) => `"${key}"`).join(', ')}. It takes: ${allowed.join(', ')}.`
    );
  }
}

function isSchema(value: unknown): value is SchemaLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  );
}

// ── Tetikleyiciler ──────────────────────────────────────────────────────────

export type ScheduleSpec =
  | { type: 'interval'; everyMs: number }
  | { type: 'daily'; hour: number; minute: number; weekdays: number[] | null }
  | { type: 'cron'; expr: string; tz: string };

export type ScheduleTrigger = { kind: 'schedule'; id: string; schedule: ScheduleSpec };
export type WebhookSignature = {
  header: string;
  prefix: string;
  encoding: 'hex' | 'base64';
};
export type WebhookTrigger = {
  kind: 'webhook';
  name: string;
  key: ((request: WebhookRequest) => string | undefined) | undefined;
  signature: WebhookSignature | null;
};
export type PollTrigger = {
  kind: 'issues' | 'pull-requests';
  id: string;
  project: string;
  provider: string | null;
};
export type WorkflowTrigger = ScheduleTrigger | WebhookTrigger | PollTrigger;

/** Zamanlanmış çalıştırmanın yükü: planlanan an (başlama anı değil). */
export type Tick = { scheduledAt: string };
/** Webhook çalıştırmasının yükü; başlık adları küçük harflidir. */
export type WebhookRequest = {
  method: string;
  headers: Record<string, string>;
  query: string;
  body: string;
};

const MIN_INTERVAL_MS = 60_000;

export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

export function every(interval: unknown): ScheduleTrigger {
  const everyMs = parseDuration(interval, `every(${JSON.stringify(interval)})`);
  if (everyMs < MIN_INTERVAL_MS) {
    throw new Error(`every(${JSON.stringify(interval)}) is shorter than one minute.`);
  }
  return { kind: 'schedule', id: `every:${everyMs}`, schedule: { type: 'interval', everyMs } };
}

export function daily(timeOfDay: string, options?: { weekdays?: number[] }): ScheduleTrigger {
  checkOptions(`daily("${timeOfDay}")`, options, ['weekdays']);
  const time = typeof timeOfDay === 'string' ? parseTimeOfDay(timeOfDay) : null;
  if (!time)
    throw new Error(`daily(${JSON.stringify(timeOfDay)}) needs a 24-hour time such as "09:00".`);
  const weekdays = options?.weekdays;
  if (weekdays?.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error(`daily's weekdays are 0 (Sunday) to 6 (Saturday), not ${weekdays.join(', ')}.`);
  }
  const sorted =
    weekdays && weekdays.length > 0 ? [...new Set(weekdays)].sort((a, b) => a - b) : null;
  return {
    kind: 'schedule',
    id: `daily:${timeOfDay}:${sorted?.join(',') ?? 'all'}`,
    schedule: { type: 'daily', ...time, weekdays: sorted },
  };
}

/** Otomasyonlarla aynı beş alanlı cron sözdizimi (croner). */
export function cron(expr: string, options?: { tz?: string }): ScheduleTrigger {
  checkOptions(`cron("${expr}")`, options, ['tz']);
  if (typeof expr !== 'string' || expr.trim().split(/\s+/).length !== 5) {
    throw new Error(`cron(${JSON.stringify(expr)}) needs a five-field cron expression.`);
  }
  const tz = options?.tz?.trim() || getLocalTimeZone();
  try {
    if (!new Cron(expr, { timezone: tz }).nextRun(new Date())) throw new Error('no next run');
  } catch {
    throw new Error(`cron(${JSON.stringify(expr)}) is not a valid expression for time zone ${tz}.`);
  }
  return {
    kind: 'schedule',
    id: `cron:${expr.trim()}:${tz}`,
    schedule: { type: 'cron', expr: expr.trim(), tz },
  };
}

const HOOK_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function webhook(
  name: string,
  options?: {
    key?: (request: WebhookRequest) => string | undefined;
    signature?: { header: string; prefix?: string; encoding?: 'hex' | 'base64' };
  }
): WebhookTrigger {
  checkOptions(`webhook("${name}")`, options, ['key', 'signature']);
  if (typeof name !== 'string' || !HOOK_NAME.test(name)) {
    throw new Error(`webhook(${JSON.stringify(name)}): use letters, digits, "-" and "_".`);
  }
  if (options?.key !== undefined && typeof options.key !== 'function') {
    throw new Error(`webhook("${name}"): key must be a function of the request.`);
  }
  const signature = options?.signature;
  if (signature !== undefined) {
    checkOptions(`webhook("${name}").signature`, signature, ['header', 'prefix', 'encoding']);
    if (typeof signature.header !== 'string' || !signature.header.trim()) {
      throw new Error(`webhook("${name}").signature needs a header name.`);
    }
    if (signature.encoding !== undefined && !['hex', 'base64'].includes(signature.encoding)) {
      throw new Error(`webhook("${name}").signature.encoding is "hex" or "base64".`);
    }
  }
  return {
    kind: 'webhook',
    name,
    key: options?.key,
    signature: signature
      ? {
          header: signature.header.trim().toLowerCase(),
          prefix: signature.prefix ?? '',
          encoding: signature.encoding ?? 'hex',
        }
      : null,
  };
}

function pollTrigger(
  kind: PollTrigger['kind'],
  where: string,
  options: { project: string; provider?: string }
): PollTrigger {
  checkOptions(where, options, kind === 'issues' ? ['project', 'provider'] : ['project']);
  if (!options || typeof options.project !== 'string' || !options.project.trim()) {
    throw new Error(`${where} needs a project (its id).`);
  }
  const provider = options.provider?.trim() || null;
  return {
    kind,
    id: JSON.stringify([kind, options.project.trim(), provider ?? '']),
    project: options.project.trim(),
    provider,
  };
}

function checkTriggers(workflowName: string, triggers: readonly WorkflowTrigger[]): void {
  const seen = new Set<string>();
  for (const trigger of triggers) {
    const id = trigger.kind === 'webhook' ? `webhook:${trigger.name}` : trigger.id;
    if (seen.has(id)) {
      throw new Error(`workflow("${workflowName}") lists the same trigger twice (${id}).`);
    }
    seen.add(id);
  }
}

// ── Tanım ───────────────────────────────────────────────────────────────────

export type RunInfo = { id: string };
export type WorkflowBody = (payload: unknown, run: RunInfo) => unknown;

export type WorkflowDefinition = {
  readonly kind: 'orkestra-workflow';
  readonly name: string;
  readonly version: number;
  readonly description: string | null;
  readonly payload: SchemaLike | null;
  readonly returns: SchemaLike | null;
  readonly triggers: readonly WorkflowTrigger[];
  readonly resumeAfterMs: readonly number[];
  readonly body: WorkflowBody;
};

export function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as WorkflowDefinition).kind === 'orkestra-workflow' &&
    typeof (value as WorkflowDefinition).body === 'function'
  );
}

export function defineWorkflow(
  name: string,
  options: {
    version: number;
    description?: string;
    payload?: SchemaLike;
    returns?: SchemaLike;
    triggers?: WorkflowTrigger[];
    resumeAfter?: unknown[];
  },
  body: WorkflowBody
): WorkflowDefinition {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new Error(
      `workflow(${JSON.stringify(name)}): names use letters, digits, "-", "_", ".", ":" and "/".`
    );
  }
  const where = `workflow("${name}")`;
  checkOptions(where, options, [
    'version',
    'description',
    'payload',
    'returns',
    'triggers',
    'resumeAfter',
  ]);
  if (!options || !Number.isInteger(options.version) || options.version < 1) {
    throw new Error(`${where} needs an integer version of 1 or more.`);
  }
  if (typeof body !== 'function') throw new Error(`${where} needs a body function.`);
  if (options.payload !== undefined && !isSchema(options.payload)) {
    throw new Error(`${where}: payload must be a schema such as Orkestra.z.object({...}).`);
  }
  if (options.returns !== undefined && !isSchema(options.returns)) {
    throw new Error(`${where}: returns must be a schema such as Orkestra.z.string().`);
  }
  const triggers = options.triggers ?? [];
  if (
    !Array.isArray(triggers) ||
    triggers.some((t) => !t || typeof t !== 'object' || !('kind' in t))
  ) {
    throw new Error(
      `${where}: triggers must be a list made with every, daily, cron, webhook, issues.opened or pullRequests.opened.`
    );
  }
  checkTriggers(name, triggers);
  const resumeAfterMs = (options.resumeAfter ?? DEFAULT_RESUME_AFTER_MS).map((value) =>
    parseDuration(value, `${where} resumeAfter`)
  );
  return {
    kind: 'orkestra-workflow',
    name,
    version: options.version,
    description: typeof options.description === 'string' ? options.description : null,
    payload: options.payload ?? null,
    returns: options.returns ?? null,
    triggers,
    resumeAfterMs,
    body,
  };
}

// ── Çalıştırma bağlamı ──────────────────────────────────────────────────────

export type StepOptions = { returns?: SchemaLike; retry?: { times: number; delay?: unknown } };
export type AgentOptions = {
  brief: string;
  task?: string;
  conversation?: string;
  provider?: string;
  model?: string;
  returns?: SchemaLike;
  timeout?: unknown;
  title?: string;
  autoApprove?: boolean;
};
export type AskOptions = { title: string; choices: string[]; data?: unknown; timeout?: unknown };
export type AskAnswer = { choice: string; reason?: string };
export type AgentResult = { value: unknown; conversation: string };

/** Motorun her çalıştırma için sağladığı ilkel uygulamaları. */
export type RunContext = {
  step(
    name: string,
    work: StepWork,
    options: StepOptions | undefined,
    tryMode: boolean
  ): Promise<unknown>;
  agent(name: string, options: AgentOptions, tryMode: boolean): Promise<unknown>;
  ask(name: string, options: AskOptions): Promise<AskAnswer | null>;
  sleep(name: string, duration: unknown): Promise<void>;
  title(text: string): void;
  end(kind: 'stopped' | 'skipped', reason: string): never;
};
export type StepWork = (helpers: { signal: AbortSignal; attempt: number }) => unknown;

type Scope = { context: RunContext; inStep: boolean };
const scope = new AsyncLocalStorage<Scope>();

export function runInContext<T>(context: RunContext, work: () => T): T {
  return scope.run({ context, inStep: false }, work);
}

export function runInStep<T>(context: RunContext, work: () => T): T {
  return scope.run({ context, inStep: true }, work);
}

function current(primitive: string, bodyOnly = true): RunContext {
  const active = scope.getStore();
  if (!active) {
    throw new Error(`${primitive}() can only be called while a workflow body runs.`);
  }
  if (bodyOnly && active.inStep) {
    throw new Error(`${primitive}() cannot be called inside a step; call it in the workflow body.`);
  }
  return active.context;
}

function checkName(primitive: string, name: unknown): asserts name is string {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new Error(
      `${primitive}(${JSON.stringify(name)}): names use letters, digits, "-", "_", ".", ":" and "/".`
    );
  }
}

function makeStep(tryMode: boolean) {
  return (name: string, work: StepWork, options?: StepOptions) => {
    const primitive = tryMode ? 'step.try' : 'step';
    checkName(primitive, name);
    if (typeof work !== 'function') throw new Error(`${primitive}("${name}") needs a function.`);
    checkOptions(`${primitive}("${name}")`, options, ['returns', 'retry']);
    return current(primitive).step(name, work, options, tryMode);
  };
}

function makeAgent(tryMode: boolean) {
  return (name: string, options: AgentOptions) => {
    const primitive = tryMode ? 'agent.try' : 'agent';
    checkName(primitive, name);
    checkOptions(`${primitive}("${name}")`, options, [
      'brief',
      'task',
      'conversation',
      'provider',
      'model',
      'returns',
      'timeout',
      'title',
      'autoApprove',
    ]);
    if (!options || typeof options.brief !== 'string' || !options.brief.trim()) {
      throw new Error(`${primitive}("${name}") needs a brief.`);
    }
    if (options.conversation !== undefined) {
      const fresh = ['task', 'provider', 'model', 'title', 'autoApprove'].filter(
        (key) => (options as Record<string, unknown>)[key] !== undefined
      );
      if (fresh.length > 0) {
        throw new Error(
          `${primitive}("${name}") continues a conversation, so it does not take ${fresh.join(', ')}.`
        );
      }
    } else if (typeof options.task !== 'string' || typeof options.provider !== 'string') {
      throw new Error(
        `${primitive}("${name}") needs a task (task id) and a provider (such as "claude"), or a conversation returned by an earlier agent step.`
      );
    }
    if (options.returns !== undefined && !isSchema(options.returns)) {
      throw new Error(`${primitive}("${name}"): returns must be a schema.`);
    }
    return current(primitive).agent(name, options, tryMode);
  };
}

const step = Object.assign(makeStep(false), { try: makeStep(true) });
const agent = Object.assign(makeAgent(false), { try: makeAgent(true) });

function ask(name: string, options: AskOptions): Promise<AskAnswer | null> {
  checkName('ask', name);
  checkOptions(`ask("${name}")`, options, ['title', 'choices', 'data', 'timeout']);
  if (!options || typeof options.title !== 'string' || !options.title.trim()) {
    throw new Error(`ask("${name}") needs a title.`);
  }
  if (
    !Array.isArray(options.choices) ||
    options.choices.length === 0 ||
    options.choices.some((choice) => typeof choice !== 'string' || !choice.trim())
  ) {
    throw new Error(`ask("${name}") needs a non-empty list of text choices.`);
  }
  return current('ask').ask(name, options);
}

function sleep(name: string, duration: unknown): Promise<void> {
  checkName('sleep', name);
  parseDuration(duration, `sleep("${name}")`);
  return current('sleep').sleep(name, duration);
}

function title(text: string): void {
  current('title').title(String(text));
}

function stop(reason: string): never {
  return current('stop').end('stopped', String(reason ?? ''));
}

function skip(reason: string): never {
  return current('skip').end('skipped', String(reason ?? ''));
}

const TickSchema = z.object({ scheduledAt: z.string() });
const WebhookRequestSchema = z.object({
  method: z.string(),
  headers: z.record(z.string(), z.string()),
  query: z.string(),
  body: z.string(),
});
const IssueSchema = z.object({
  provider: z.string(),
  identifier: z.string(),
  displayIdentifier: z.string().nullable(),
  title: z.string(),
  url: z.string(),
  project: z.string(),
});
const PullRequestSchema = z.object({
  identifier: z.string(),
  number: z.number().nullable(),
  title: z.string(),
  url: z.string(),
  author: z.string().nullable(),
  project: z.string(),
});

/** `workflow` yükleyici tarafından dosyaya bağlanır; geri kalanı bu nesnedir. */
export function createAuthoringApi(workflow: typeof defineWorkflow) {
  return Object.freeze({
    workflow,
    step,
    agent,
    ask,
    sleep,
    title,
    stop,
    skip,
    every,
    daily,
    cron,
    webhook,
    issues: Object.freeze({
      opened: (options: { project: string; provider?: string }) =>
        pollTrigger('issues', 'issues.opened', options),
    }),
    pullRequests: Object.freeze({
      opened: (options: { project: string }) =>
        pollTrigger('pull-requests', 'pullRequests.opened', options),
    }),
    Tick: TickSchema,
    WebhookRequest: WebhookRequestSchema,
    Issue: IssueSchema,
    PullRequest: PullRequestSchema,
    z,
  });
}

export type IssuePayload = z.infer<typeof IssueSchema>;
export type PullRequestPayload = z.infer<typeof PullRequestSchema>;
