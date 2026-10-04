import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AcpSessionMcpServer } from '@orkestra/core/runtimes/acp/api/client';
import type { Result } from '@orkestra/shared';
import type { Logger } from '@orkestra/shared/logger';
import { z } from 'zod';
import type {
  OrchestraSession,
  OrchestraSettings,
  OrchestraWorkerStatus,
  OrchestraWorkerSummary,
} from '@core/features/orchestra/api/orchestra';
import { orchestraSettingsSchema } from '@core/features/orchestra/api/orchestra';
import { ensureOrchestraBridgeScript } from '@core/features/orchestra/node/orchestra-mcp-bridge';
import {
  buildConductorPlaybook,
  buildWorkerBrief,
  ORCHESTRA_MCP_SERVER_NAME,
  routingProfileFor,
} from '@core/features/orchestra/node/orchestra-playbook';
import {
  startOrchestraRpcServer,
  type OrchestraRpcServer,
} from '@core/features/orchestra/node/orchestra-rpc-server';
import {
  ORCHESTRA_TOOLS,
  type OrchestraToolName,
} from '@core/features/orchestra/node/orchestra-tools';
import type { Conversation, CreateConversationParams } from '@core/primitives/conversations/api';

type TurnLike = {
  outcome?: { kind: string; message?: string };
  items: Array<{ kind: string; role?: string; promptId?: string; text?: string }>;
};

/** Ana süreç bağımlılıkları; konuşmalar denetleyicisi tarafından enjekte edilir. */
export type OrchestraServiceDeps = {
  dataDirectory: string;
  electronExecutable: string;
  logger: Logger;
  createConversation(params: CreateConversationParams): Promise<Conversation>;
  /** Konuşmanın ACP oturumunu bağlar (gerekirse ACP girdisini çözer). */
  attach(conversationId: string): Promise<Result<unknown, unknown>>;
  sendPrompt(input: {
    conversationId: string;
    promptId: string;
    prompt: { text: string; hiddenContext?: string };
  }): Promise<Result<unknown, unknown>>;
  cancelTurn(conversationId: string): Promise<Result<unknown, unknown>>;
  loadHistory(
    conversationId: string,
    limit: number
  ): Promise<Result<{ turns: TurnLike[]; unavailable?: true }, unknown>>;
  /** Bekleyen izin istekleri; okunamazsa null. */
  pendingPermissions(conversationId: string): Promise<PendingPermission[] | null>;
  resolvePermission(input: {
    conversationId: string;
    requestId: string;
    optionId: string;
  }): Promise<Result<unknown, unknown>>;
};

export type PendingPermission = {
  requestId: string;
  options: Array<{ optionId: string; kind: string }>;
};

const workerRecordSchema = z.object({
  workerId: z.string(),
  providerId: z.string(),
  agentName: z.string(),
  model: z.string().nullable(),
  title: z.string(),
  role: z.string().nullable(),
  createdAt: z.number(),
  lastPromptId: z.string().nullable(),
  lastPromptAt: z.number().nullable(),
  settled: z.enum(['done', 'error', 'cancelled']).nullable(),
});
type WorkerRecord = z.infer<typeof workerRecordSchema>;

const sessionRecordSchema = z.object({
  conversationId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  settings: orchestraSettingsSchema,
  workers: z.array(workerRecordSchema),
});
type SessionRecord = z.infer<typeof sessionRecordSchema>;

const providerStatsSchema = z.object({
  done: z.number(),
  error: z.number(),
  cancelled: z.number(),
  totalSeconds: z.number(),
});
type ProviderStats = z.infer<typeof providerStatsSchema>;

const storeSchema = z.object({
  version: z.literal(1),
  sessions: z.record(z.string(), sessionRecordSchema),
  stats: z.record(z.string(), providerStatsSchema),
});
type Store = z.infer<typeof storeSchema>;

type WorkerState = {
  status: OrchestraWorkerStatus;
  report: string | null;
  errorMessage: string | null;
};

const MAX_REPORT_CHARS = 12_000;
const WAIT_POLL_MS = 2_000;
const DEFAULT_WAIT_SECONDS = 50;
const MAX_WAIT_SECONDS = 600;
const PERMISSION_WATCH_MS = 2_500;

export class OrchestraService {
  private store: Store = { version: 1, sessions: {}, stats: {} };
  private loaded: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  /** Belirteçler yalnızca bellekte tutulur; her uygulama açılışında yenilenir. */
  private readonly tokens = new Map<string, string>();
  private readonly conversationsByToken = new Map<string, string>();
  private server: Promise<OrchestraRpcServer> | null = null;
  private permissionWatcher: ReturnType<typeof setInterval> | null = null;
  private permissionSweep: Promise<void> | null = null;

  constructor(private readonly deps: OrchestraServiceDeps) {}

  private get storePath(): string {
    return join(this.deps.dataDirectory, 'orchestra', 'sessions.json');
  }

  private async ensureLoaded(): Promise<void> {
    this.loaded ??= (async () => {
      const raw = await readFile(this.storePath, 'utf8').catch(() => null);
      if (!raw) return;
      try {
        const parsed = storeSchema.safeParse(JSON.parse(raw));
        if (parsed.success) this.store = parsed.data;
        else this.deps.logger.warn('Orkestra: oturum kaydı şeması geçersiz, sıfırlanıyor');
      } catch (error) {
        this.deps.logger.warn('Orkestra: oturum kaydı okunamadı', { error: String(error) });
      }
    })();
    await this.loaded;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.store, null, 2);
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(this.storePath), { recursive: true });
        const temp = `${this.storePath}.${process.pid}.tmp`;
        await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.storePath);
      })
      .catch((error) => {
        this.deps.logger.warn('Orkestra: oturum kaydı yazılamadı', { error: String(error) });
      });
    return this.writeChain;
  }

  // ── Renderer yüzeyi ─────────────────────────────────────────────────────────

  async register(input: {
    conversationId: string;
    projectId: string;
    taskId: string;
    settings: OrchestraSettings;
  }): Promise<void> {
    await this.ensureLoaded();
    const settings = orchestraSettingsSchema.parse(input.settings);
    const existing = this.store.sessions[input.conversationId];
    this.store.sessions[input.conversationId] = {
      conversationId: input.conversationId,
      projectId: input.projectId,
      taskId: input.taskId,
      settings,
      workers: existing?.workers ?? [],
    };
    await this.persist();
  }

  async get(conversationId: string): Promise<OrchestraSession | null> {
    await this.ensureLoaded();
    const session = this.store.sessions[conversationId];
    if (!session) return null;
    return {
      conversationId,
      settings: session.settings,
      workers: session.workers.map(toSummary),
    };
  }

  async conductorContext(conversationId: string): Promise<string | null> {
    await this.ensureLoaded();
    const session = this.store.sessions[conversationId];
    return session ? buildConductorPlaybook(session.settings) : null;
  }

  /** Şef konuşmasının ACP oturumuna eklenecek MCP köprüsü; şef değilse null. */
  async conductorMcpServers(conversationId: string): Promise<AcpSessionMcpServer[] | null> {
    await this.ensureLoaded();
    if (!this.store.sessions[conversationId]) return null;
    const [server, script] = await Promise.all([
      this.ensureServer(),
      ensureOrchestraBridgeScript(join(this.deps.dataDirectory, 'orchestra')),
    ]);
    this.ensurePermissionWatcher();
    let token = this.tokens.get(conversationId);
    if (!token) {
      token = randomBytes(32).toString('hex');
      this.tokens.set(conversationId, token);
      this.conversationsByToken.set(token, conversationId);
    }
    return [
      {
        name: ORCHESTRA_MCP_SERVER_NAME,
        command: this.deps.electronExecutable,
        args: [script],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          ORKESTRA_ORCHESTRA_URL: server.url,
          ORKESTRA_ORCHESTRA_TOKEN: token,
        },
      },
    ];
  }

  async dispose(): Promise<void> {
    if (this.permissionWatcher) clearInterval(this.permissionWatcher);
    this.permissionWatcher = null;
    await this.permissionSweep;
    const server = this.server;
    this.server = null;
    if (server) await (await server).close();
    await this.writeChain;
  }

  private ensureServer(): Promise<OrchestraRpcServer> {
    this.server ??= startOrchestraRpcServer({
      authenticate: (token) => this.conversationsByToken.get(token) ?? null,
      handle: (conversationId, method, params) => this.handleRpc(conversationId, method, params),
      logger: this.deps.logger,
    });
    return this.server;
  }

  // ── Şef araçları ───────────────────────────────────────────────────────────

  private async handleRpc(
    conversationId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    await this.ensureLoaded();
    const session = this.store.sessions[conversationId];
    if (!session) throw new Error('Bu konuşma bir Orkestra şefi değil.');
    if (method === 'describe') {
      return {
        instructions: buildConductorPlaybook(session.settings),
        tools: ORCHESTRA_TOOLS,
      };
    }
    if (method !== 'call') throw new Error(`Bilinmeyen yöntem: ${method}`);
    const name = String(params.name ?? '') as OrchestraToolName;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await this.callTool(session, name, args);
      return { text: JSON.stringify(result, null, 2) };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  private async callTool(
    session: SessionRecord,
    name: OrchestraToolName,
    args: Record<string, unknown>
  ): Promise<unknown> {
    switch (name) {
      case 'list_agents':
        return this.listAgents(session);
      case 'spawn_agent':
        return this.spawnAgent(session, args);
      case 'message_agent':
        return this.messageAgent(session, args);
      case 'wait_for_agents':
        return this.waitForAgents(session, args);
      case 'get_agent_result': {
        const worker = requireWorker(session, args.worker_id);
        return this.describeWorker(session, worker, args.full === true);
      }
      case 'list_workers':
        return {
          workers: await Promise.all(
            session.workers.map((worker) => this.describeWorker(session, worker, false, true))
          ),
        };
      case 'cancel_agent': {
        const worker = requireWorker(session, args.worker_id);
        const result = await this.deps.cancelTurn(worker.workerId);
        if (!result.success) throw new Error(`İptal edilemedi: ${describeError(result.error)}`);
        return { worker_id: worker.workerId, cancelled: true };
      }
      default:
        throw new Error(`Bilinmeyen araç: ${String(name)}`);
    }
  }

  private async listAgents(session: SessionRecord) {
    const running = await this.runningWorkers(session);
    return {
      max_parallel: session.settings.maxParallel === 0 ? 'unlimited' : session.settings.maxParallel,
      running_workers: running.length,
      routing_notes: session.settings.routingNotes.trim() || null,
      agents: session.settings.workers.map((agent) => {
        const profile = routingProfileFor(agent.providerId);
        const stats = this.store.stats[agent.providerId];
        const settled = stats ? stats.done + stats.error + stats.cancelled : 0;
        return {
          agent: agent.providerId,
          name: agent.name,
          family: profile.family,
          strengths: profile.strengths,
          avoid_for: profile.avoidFor,
          best_roles: profile.bestRoles,
          cost: profile.cost,
          speed: profile.speed,
          models: agent.models.map((model) => ({ id: model.id, name: model.name })),
          running: running.filter((worker) => worker.providerId === agent.providerId).length,
          observed:
            stats && settled > 0
              ? {
                  tasks: settled,
                  success_rate: Math.round((stats.done / settled) * 100) / 100,
                  avg_minutes: Math.round((stats.totalSeconds / settled / 60) * 10) / 10,
                }
              : null,
        };
      }),
    };
  }

  private async spawnAgent(session: SessionRecord, args: Record<string, unknown>) {
    const providerId = requireString(args.agent, 'agent');
    const task = requireString(args.task, 'task');
    const agent = session.settings.workers.find((worker) => worker.providerId === providerId);
    if (!agent) {
      const allowed = session.settings.workers.map((worker) => worker.providerId).join(', ');
      throw new Error(`"${providerId}" bu orkestrada kullanılamaz. Kullanılabilir: ${allowed}`);
    }
    const requestedModel = typeof args.model === 'string' && args.model.trim() ? args.model : null;
    if (requestedModel && !agent.models.some((model) => model.id === requestedModel)) {
      const models = agent.models.map((model) => model.id).join(', ') || 'yalnızca varsayılan';
      throw new Error(`"${requestedModel}" ${agent.name} için geçerli değil. Modeller: ${models}`);
    }
    if (session.settings.maxParallel > 0) {
      const running = await this.runningWorkers(session);
      if (running.length >= session.settings.maxParallel) {
        throw new Error(
          `Paralel sınırına ulaşıldı (${session.settings.maxParallel}). Önce wait_for_agents ile bir işçinin bitmesini bekleyin.`
        );
      }
    }
    const title = (typeof args.title === 'string' && args.title.trim()) || summarizeTitle(task);
    const role = typeof args.role === 'string' && args.role.trim() ? args.role.trim() : null;
    const workerId = randomUUID();
    await this.deps.createConversation({
      id: workerId,
      projectId: session.projectId,
      taskId: session.taskId,
      provider: providerId as CreateConversationParams['provider'],
      title: `🎼 ${agent.name} · ${title}`.slice(0, 120),
      autoApprove: session.settings.autoApproveWorkers,
      ...(requestedModel ? { model: requestedModel } : {}),
      type: 'acp',
    });
    const worker: WorkerRecord = {
      workerId,
      providerId,
      agentName: agent.name,
      model: requestedModel,
      title,
      role,
      createdAt: Date.now(),
      lastPromptId: null,
      lastPromptAt: null,
      settled: null,
    };
    session.workers.push(worker);
    await this.persist();

    const attached = await this.deps.attach(workerId);
    if (!attached.success) {
      throw new Error(`${agent.name} başlatılamadı: ${describeError(attached.error)}`);
    }
    await this.deliver(worker, task, buildWorkerBrief({ title, role }));
    return {
      worker_id: workerId,
      agent: providerId,
      model: requestedModel ?? 'default',
      title,
      status: 'running',
      hint: 'Spawn other independent workers now, then call wait_for_agents.',
    };
  }

  private async messageAgent(session: SessionRecord, args: Record<string, unknown>) {
    const worker = requireWorker(session, args.worker_id);
    const message = requireString(args.message, 'message');
    const attached = await this.deps.attach(worker.workerId);
    if (!attached.success) throw new Error(`İşçiye ulaşılamadı: ${describeError(attached.error)}`);
    await this.deliver(worker, message);
    return { worker_id: worker.workerId, status: 'running' };
  }

  private async deliver(worker: WorkerRecord, text: string, hiddenContext?: string): Promise<void> {
    const promptId = randomUUID();
    const result = await this.deps.sendPrompt({
      conversationId: worker.workerId,
      promptId,
      prompt: { text, ...(hiddenContext ? { hiddenContext } : {}) },
    });
    if (!result.success) throw new Error(`İstem gönderilemedi: ${describeError(result.error)}`);
    worker.lastPromptId = promptId;
    worker.lastPromptAt = Date.now();
    worker.settled = null;
    await this.persist();
    this.ensurePermissionWatcher();
  }

  private async waitForAgents(session: SessionRecord, args: Record<string, unknown>) {
    const ids = Array.isArray(args.worker_ids)
      ? args.worker_ids.filter((id): id is string => typeof id === 'string')
      : [];
    const workers = ids.length
      ? ids.map((id) => requireWorker(session, id))
      : session.workers.filter((worker) => worker.lastPromptId !== null);
    if (workers.length === 0) return { workers: [], note: 'Beklenecek işçi yok.' };
    const mode = args.mode === 'any' ? 'any' : 'all';
    const timeoutSeconds = clampNumber(
      args.timeout_seconds,
      DEFAULT_WAIT_SECONDS,
      5,
      MAX_WAIT_SECONDS
    );
    const deadline = Date.now() + timeoutSeconds * 1000;
    let states = await Promise.all(workers.map((worker) => this.workerState(session, worker)));
    const finished = () => states.filter((state) => isTerminal(state.status)).length;
    while (
      Date.now() < deadline &&
      (mode === 'all' ? finished() < workers.length : finished() === 0)
    ) {
      await delay(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
      states = await Promise.all(workers.map((worker) => this.workerState(session, worker)));
    }
    const allDone = finished() === workers.length;
    return {
      complete: mode === 'all' ? allDone : finished() > 0,
      workers: workers.map((worker, index) => formatWorker(worker, states[index]!, false)),
      ...(allDone
        ? {}
        : { note: 'Some workers are still running. Call wait_for_agents again to keep waiting.' }),
    };
  }

  private async describeWorker(
    session: SessionRecord,
    worker: WorkerRecord,
    full: boolean,
    brief = false
  ) {
    const state = await this.workerState(session, worker);
    const formatted = formatWorker(worker, state, full);
    if (brief) return { ...formatted, report: undefined };
    return formatted;
  }

  private async runningWorkers(session: SessionRecord): Promise<WorkerRecord[]> {
    const active = session.workers.filter(
      (worker) => worker.lastPromptId !== null && worker.settled === null
    );
    const states = await Promise.all(active.map((worker) => this.workerState(session, worker)));
    return active.filter((_, index) => !isTerminal(states[index]!.status));
  }

  /** Son istemin turunu geçmişte arar; tur bittiyse son yanıtı rapor olarak döndürür. */
  private async workerState(session: SessionRecord, worker: WorkerRecord): Promise<WorkerState> {
    if (!worker.lastPromptId) return { status: 'starting', report: null, errorMessage: null };
    const history = await this.deps.loadHistory(worker.workerId, 20);
    if (history.success && !history.data.unavailable) {
      const turn = history.data.turns.find((candidate) =>
        candidate.items.some(
          (item) =>
            item.kind === 'message' && item.role === 'user' && item.promptId === worker.lastPromptId
        )
      );
      if (turn?.outcome) {
        const report = turn.items
          .filter((item) => item.kind === 'message' && item.role === 'assistant' && item.text)
          .map((item) => item.text)
          .join('\n\n')
          .trim();
        const status: OrchestraWorkerStatus =
          turn.outcome.kind === 'done'
            ? 'done'
            : turn.outcome.kind === 'cancelled'
              ? 'cancelled'
              : 'error';
        await this.settle(session, worker, status);
        return {
          status,
          report: report || null,
          errorMessage: status === 'error' ? (turn.outcome.message ?? turn.outcome.kind) : null,
        };
      }
    }
    const pending = await this.pendingAfterAutoApprove(session, worker.workerId);
    return {
      status: pending > 0 ? 'awaiting-permission' : 'running',
      report: null,
      errorMessage: null,
    };
  }

  /**
   * ACP oturumlarında otomatik onay bir başlatma bayrağı değildir; izin istekleri oturuma düşer.
   * Otomatik onay açıkken istekler, sağlayıcıdan bağımsız olarak bir "izin ver" seçeneğiyle
   * yanıtlanır. Kalan (yanıtlanamayan) istek sayısını döndürür.
   */
  private async pendingAfterAutoApprove(
    session: SessionRecord,
    conversationId: string
  ): Promise<number> {
    const pending = await this.deps.pendingPermissions(conversationId);
    if (!pending?.length) return 0;
    if (!session.settings.autoApproveWorkers) return pending.length;
    let remaining = 0;
    for (const request of pending) {
      const option =
        request.options.find((candidate) => candidate.kind === 'allow_once') ??
        request.options.find((candidate) => candidate.kind === 'allow_always');
      if (!option) {
        remaining += 1;
        continue;
      }
      const result = await this.deps.resolvePermission({
        conversationId,
        requestId: request.requestId,
        optionId: option.optionId,
      });
      if (!result.success) remaining += 1;
    }
    return remaining;
  }

  /** Otomatik onaylı oturumlarda, şef beklemiyorken de işçilerin takılmamasını sağlar. */
  private ensurePermissionWatcher(): void {
    if (this.permissionWatcher) return;
    this.permissionWatcher = setInterval(() => {
      if (this.permissionSweep) return;
      this.permissionSweep = this.sweepPermissions()
        .catch((error) => {
          this.deps.logger.warn('Orkestra: izin taraması başarısız', { error: String(error) });
        })
        .finally(() => {
          this.permissionSweep = null;
        });
    }, PERMISSION_WATCH_MS);
    this.permissionWatcher.unref?.();
  }

  private async sweepPermissions(): Promise<void> {
    let active = 0;
    for (const session of Object.values(this.store.sessions)) {
      if (!session.settings.autoApproveWorkers) continue;
      // Şef, bu uygulama oturumunda MCP köprüsü verilmişse etkin kabul edilir.
      const targets = [
        ...(this.tokens.has(session.conversationId) ? [session.conversationId] : []),
        ...session.workers
          .filter((worker) => worker.lastPromptId !== null && worker.settled === null)
          .map((worker) => worker.workerId),
      ];
      active += targets.length;
      await Promise.all(
        targets.map((id) => this.pendingAfterAutoApprove(session, id).catch(() => 0))
      );
    }
    if (active === 0 && this.permissionWatcher) {
      clearInterval(this.permissionWatcher);
      this.permissionWatcher = null;
    }
  }

  private async settle(
    session: SessionRecord,
    worker: WorkerRecord,
    status: OrchestraWorkerStatus
  ): Promise<void> {
    if (worker.settled !== null || !isTerminal(status)) return;
    worker.settled = status as WorkerRecord['settled'];
    const stats: ProviderStats = this.store.stats[worker.providerId] ?? {
      done: 0,
      error: 0,
      cancelled: 0,
      totalSeconds: 0,
    };
    if (status === 'done') stats.done += 1;
    else if (status === 'cancelled') stats.cancelled += 1;
    else stats.error += 1;
    stats.totalSeconds += Math.max(0, (Date.now() - (worker.lastPromptAt ?? Date.now())) / 1000);
    this.store.stats[worker.providerId] = stats;
    this.deps.logger.info('Orkestra: işçi tamamlandı', {
      conductor: session.conversationId,
      worker: worker.workerId,
      provider: worker.providerId,
      status,
    });
    await this.persist();
  }
}

function toSummary(worker: WorkerRecord): OrchestraWorkerSummary {
  return {
    workerId: worker.workerId,
    providerId: worker.providerId,
    agentName: worker.agentName,
    model: worker.model,
    title: worker.title,
    role: worker.role,
    createdAt: worker.createdAt,
  };
}

function formatWorker(worker: WorkerRecord, state: WorkerState, full: boolean) {
  const report =
    state.report && !full && state.report.length > MAX_REPORT_CHARS
      ? `${state.report.slice(0, MAX_REPORT_CHARS)}\n…[truncated; call get_agent_result with full=true]`
      : state.report;
  return {
    worker_id: worker.workerId,
    agent: worker.providerId,
    model: worker.model ?? 'default',
    title: worker.title,
    role: worker.role,
    status: state.status,
    ...(state.status === 'awaiting-permission'
      ? {
          note: `Waiting for the user to approve a permission in the "${worker.title}" conversation.`,
        }
      : {}),
    ...(state.errorMessage ? { error: state.errorMessage } : {}),
    report,
  };
}

function requireWorker(session: SessionRecord, id: unknown): WorkerRecord {
  const workerId = requireString(id, 'worker_id');
  const worker = session.workers.find((candidate) => candidate.workerId === workerId);
  if (!worker) throw new Error(`İşçi bulunamadı: ${workerId}`);
  return worker;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${field}" alanı gerekli.`);
  return value;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, number));
}

function isTerminal(status: OrchestraWorkerStatus): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled';
}

function summarizeTitle(task: string): string {
  const line = task.trim().split('\n')[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'Görev';
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; type?: unknown };
    if (typeof record.message === 'string') return record.message;
    if (typeof record.type === 'string') return record.type;
  }
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
