import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  isLocalHostRef,
  sshConnectionIdOf,
  type HostRef,
} from '@orkestra/core/primitives/host/api';
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
import {
  orchestraSettingsSchema,
  type OrchestraWorkerAgent,
} from '@core/features/orchestra/api/orchestra';
import {
  capableOrchestraModels,
  difficultyRank,
  effortForDifficulty,
  findCatalogModel,
  findLiveModelOption,
  isOrchestraDifficulty,
  isOrchestraEffort,
  isReservedForDifficulty,
  ORCHESTRA_DIFFICULTIES,
  orchestraModelProfile,
  recommendOrchestraModel,
  usableOrchestraModels,
  type OrchestraDifficulty,
  type OrchestraEffort,
  type OrchestraLiveModelOption,
  type OrchestraModelInput,
} from '@core/features/orchestra/api/orchestra-models';
import { ensureOrchestraBridgeScript } from '@core/features/orchestra/node/orchestra-mcp-bridge';
import {
  buildConductorPlaybook,
  buildWorkerBrief,
  ORCHESTRA_MCP_SERVER_NAME,
  routingProfileFor,
} from '@core/features/orchestra/node/orchestra-playbook';
import { OrchestraRemoteEndpoints } from '@core/features/orchestra/node/orchestra-remote-endpoint';
import {
  startOrchestraRpcServer,
  type OrchestraRpcServer,
} from '@core/features/orchestra/node/orchestra-rpc-server';
import {
  ORCHESTRA_TOOLS,
  type OrchestraToolName,
} from '@core/features/orchestra/node/orchestra-tools';
import type { Conversation, CreateConversationParams } from '@core/primitives/conversations/api';
import type { SshClientProxy } from '@core/primitives/ssh/api/node/ssh-client-proxy';

type TurnItemLike = { kind: string; role?: string; promptId?: string; text?: string };

type TurnLike = {
  outcome?: { kind: string; reason?: string; message?: string };
  items: TurnItemLike[];
};

/** İşçi oturumunun canlı durumu (ACP oturumunun `state` canlı modeli). */
export type WorkerSessionState = {
  lifecycle: string;
  /** Konuşma tutuluyor ama sağlayıcı oturumu etkin değil (boşta kapatıldı, uygulama yeniden açıldı). */
  suspended: boolean;
  isGenerating: boolean;
  queuedPromptIds: string[];
};

/** Etkin oturumun model seçicisi. */
export type WorkerModelState = {
  /** Sağlayıcının bildirdiği, oturumun gerçekten kullandığı model. */
  selected: string | null;
  available: OrchestraLiveModelOption[];
};

/** Ana süreç bağımlılıkları; konuşmalar denetleyicisi tarafından enjekte edilir. */
export type OrchestraServiceDeps = {
  dataDirectory: string;
  electronExecutable: string;
  /** Uzak (SSH) şefler için ters tünelin kurulacağı bağlantı; yoksa yalnızca yerel çalışır. */
  getSshProxy?: (connectionId: string) => SshClientProxy | undefined;
  logger: Logger;
  createConversation(params: CreateConversationParams): Promise<Conversation>;
  /** Konuşmayı canlı oturumuyla birlikte siler; başlatılamayan işçiler sohbette kalmasın diye. */
  deleteConversation(input: {
    projectId: string;
    taskId: string;
    conversationId: string;
  }): Promise<void>;
  /** Konuşmanın ACP oturumunu bağlar (gerekirse ACP girdisini çözer). */
  attach(conversationId: string): Promise<Result<unknown, unknown>>;
  sendPrompt(input: {
    conversationId: string;
    promptId: string;
    prompt: { text: string; hiddenContext?: string };
  }): Promise<Result<unknown, unknown>>;
  cancelTurn(conversationId: string): Promise<Result<unknown, unknown>>;
  /** Kuyruktaki bir istemi siler; iptal edilen turun ardından kuyruk işçiyi yeniden başlatmasın. */
  deleteQueuedPrompt(input: {
    conversationId: string;
    id: string;
  }): Promise<Result<unknown, unknown>>;
  /** Oturumu sonlandırır (sağlayıcı süreci kapanır); konuşma sonradan yeniden bağlanabilir. */
  terminate(conversationId: string): Promise<Result<unknown, unknown>>;
  /** Geçmiş isteği, askıdaki oturumu etkinleştirir. */
  loadHistory(
    conversationId: string,
    limit: number
  ): Promise<Result<{ turns: TurnLike[]; unavailable?: true }, unknown>>;
  /** Oturumun canlı durumu; okunamazsa null. */
  sessionState(conversationId: string): Promise<WorkerSessionState | null>;
  /**
   * Etkin oturumun model seçicisi; sağlayıcı model seçimi sunmuyorsa null. Oturum etkin değilse
   * ya da okunamazsa hata fırlatır.
   */
  sessionModel(conversationId: string): Promise<WorkerModelState | null>;
  /**
   * Düşünme seviyesini sağlayıcının en yakın seçeneğine ayarlar; uygulanan seçeneğin adını döner.
   * Sağlayıcı düşünme seviyesi sunmuyorsa null döner.
   */
  setEffort?: (conversationId: string, effort: OrchestraEffort) => Promise<string | null>;
  /**
   * Oturumun modelini sağlayıcının kendi seçenek kimliğiyle değiştirir ve konuşma ayarına yazar
   * (yeniden açılışta da uygulansın diye); uygulanamazsa false döner.
   */
  setModel?: (conversationId: string, model: string) => Promise<boolean>;
  /** Bekleyen izin istekleri; okunamazsa null. */
  pendingPermissions(conversationId: string): Promise<PendingPermission[] | null>;
  resolvePermission(input: {
    conversationId: string;
    requestId: string;
    optionId: string;
  }): Promise<Result<unknown, unknown>>;
  /** Bekleme süreleri (ms); varsayılanlar üretim içindir, testler kısaltır. */
  timing?: { cancelGraceMs?: number; lostGraceMs?: number };
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
  /** Görünen model adı ve şefin seçim gerekçesi; eski kayıtlarda bulunmayabilir. */
  modelName: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  settledAt: z.number().nullable().optional(),
  difficulty: z.enum(ORCHESTRA_DIFFICULTIES).nullable().optional(),
  effort: z.string().nullable().optional(),
  /** Şefin araç satırında gösterdiği açıklama; sohbetteki satırı işçiyle eşlemek için. */
  description: z.string().nullable().optional(),
  /**
   * Son istemin görünen metninin özeti. Oturum yeniden açıldığında geçmiş istem kimliği
   * taşımadan yeniden oynatılır; tur bu özetle bulunur.
   */
  lastPromptText: z.string().nullable().optional(),
  /** Kesinleşen turun raporu ve hatası; sonraki okumalarda geçmiş yeniden yüklenmez. */
  report: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  /**
   * Sonuç belirlenemedi (oturum kayboldu, konuşma silindi, tur yarıda kesildi). Eski sürümler
   * kaydı okuyabilsin diye bu durumda `settled` 'error' olarak tutulur.
   */
  lost: z.literal(true).optional(),
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

type TerminalStatus = 'done' | 'error' | 'cancelled' | 'lost';

type CallFailure = { ok: false; reason: string; missing: boolean };
type HistoryRead = { ok: true; turns: TurnLike[] } | CallFailure;

const MAX_REPORT_CHARS = 12_000;
const MAX_STORED_REPORT_CHARS = 100_000;
const WAIT_POLL_MS = 2_000;
const DEFAULT_WAIT_SECONDS = 50;
const MAX_WAIT_SECONDS = 600;
const PERMISSION_WATCH_MS = 2_500;
const HISTORY_TURNS = 20;
const PROMPT_FINGERPRINT_CHARS = 160;
const CANCEL_GRACE_MS = 8_000;
const CANCEL_POLL_MS = 250;
/** Geçici kopmalar (SSH, yeniden bağlanma) işçiyi hemen kayıp saydırmasın. */
const LOST_GRACE_MS = 30_000;
const BUSY_LIFECYCLES = new Set(['starting', 'replaying', 'working', 'cancelling']);
const LOST_HINT =
  'Değişiklikleri git diff ile kontrol edin; gerekirse message_agent ile işçiden rapor isteyin ya da görevi yeniden dağıtın.';

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
  private readonly remote: OrchestraRemoteEndpoints | null;
  /** Şef ve sağlayıcı başına, işçi oturumlarının gerçekten sunduğu modeller (etkinleşmede öğrenilir). */
  private readonly liveModels = new Map<string, OrchestraLiveModelOption[]>();
  /** Durumu belirlenemeyen işçilerin ilk başarısız gözlem zamanı. */
  private readonly unresolvedSince = new Map<string, number>();

  constructor(private readonly deps: OrchestraServiceDeps) {
    const getProxy = deps.getSshProxy;
    this.remote = getProxy
      ? new OrchestraRemoteEndpoints({
          getProxy,
          localRpcPort: async () => Number(new URL((await this.ensureServer()).url).port),
          logger: deps.logger,
        })
      : null;
  }

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
  async conductorMcpServers(
    conversationId: string,
    host?: HostRef
  ): Promise<AcpSessionMcpServer[] | null> {
    await this.ensureLoaded();
    if (!this.store.sessions[conversationId]) return null;
    const token = this.tokenFor(conversationId);
    const connectionId = host && !isLocalHostRef(host) ? sshConnectionIdOf(host) : undefined;
    if (connectionId) {
      if (!this.remote) return null;
      // Uzak şefin köprüsü, SSH ters tüneliyle bu makinedeki RPC sunucusuna bağlanır.
      const endpoint = await this.remote.ensure(connectionId);
      this.ensurePermissionWatcher();
      return [
        {
          name: ORCHESTRA_MCP_SERVER_NAME,
          command: endpoint.nodePath,
          args: [endpoint.scriptPath],
          env: {
            ORKESTRA_ORCHESTRA_SOCKET: endpoint.socketPath,
            ORKESTRA_ORCHESTRA_TOKEN: token,
          },
        },
      ];
    }
    const [server, script] = await Promise.all([
      this.ensureServer(),
      ensureOrchestraBridgeScript(join(this.deps.dataDirectory, 'orchestra')),
    ]);
    this.ensurePermissionWatcher();
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

  private tokenFor(conversationId: string): string {
    let token = this.tokens.get(conversationId);
    if (!token) {
      token = randomBytes(32).toString('hex');
      this.tokens.set(conversationId, token);
      this.conversationsByToken.set(token, conversationId);
    }
    return token;
  }

  async dispose(): Promise<void> {
    this.remote?.dispose();
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
      case 'cancel_agent':
        return this.cancelAgent(session, requireWorker(session, args.worker_id));
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
      model_rules: [
        'Classify every subtask as trivial, standard, hard or critical and pass it as difficulty.',
        'Omit model to let Orkestra pick the recommended model for that difficulty, or pick one from the list.',
        'You do not need to use every agent; several workers may use the same agent and model.',
        'Older-generation and excluded models are not offered and will be rejected.',
        'GPT Astra models (every version) are never used as workers. Claude Fable models are reserved for critical work.',
        'Orkestra verifies the model each worker session really runs. If the provider cannot run the chosen model, the worker is removed and the error lists usable models.',
      ],
      agents: session.settings.workers.map((agent) => {
        const profile = routingProfileFor(agent.providerId);
        const models = this.workerModels(session, agent);
        const stats = this.store.stats[agent.providerId];
        const settled = stats ? stats.done + stats.error + stats.cancelled : 0;
        const recommended = Object.fromEntries(
          ORCHESTRA_DIFFICULTIES.map((difficulty) => [
            difficulty,
            recommendOrchestraModel(agent.providerId, models, difficulty)?.id ?? null,
          ])
        );
        const unavailable = agent.models
          .filter((model) => !models.includes(model))
          .map((model) => model.id);
        return {
          agent: agent.providerId,
          name: agent.name,
          family: profile.family,
          strengths: profile.strengths,
          avoid_for: profile.avoidFor,
          best_roles: profile.bestRoles,
          cost: profile.cost,
          speed: profile.speed,
          recommended_model_by_difficulty: models.length > 0 ? recommended : null,
          models: usableOrchestraModels(agent.providerId, models).map((model) => ({
            id: model.id,
            name: model.name,
            role: model.profile.role,
            max_difficulty: model.profile.maxDifficulty,
            ...(model.profile.reserved ? { reserved_for: 'critical' } : {}),
            note: model.profile.note,
          })),
          ...(unavailable.length > 0 ? { not_offered_by_session: unavailable } : {}),
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

  /**
   * Modeli doğrular ya da zorluğa göre seçer. Yasaklı modeller, aynı sağlayıcıda yenisi varken
   * eski nesil modeller, kritik olmayan işler için kıt modeller ve işin zorluğuna yetmeyen
   * modeller reddedilir. `models`, oturumun gerçekten sunduğu modellerle sınırlanmış katalogdur.
   */
  private selectWorkerModel(
    agent: OrchestraWorkerAgent,
    models: OrchestraWorkerAgent['models'],
    requested: string | null,
    difficulty: OrchestraDifficulty
  ): { model: OrchestraWorkerAgent['models'][number] | null; autoSelected: boolean } {
    if (agent.models.length === 0) {
      if (requested)
        throw new Error(`${agent.name} model seçimi desteklemiyor; model alanını boş bırakın.`);
      return { model: null, autoSelected: false };
    }
    if (models.length === 0) {
      throw new Error(
        `${agent.name} oturumu bu orkestranın tanıdığı modellerin hiçbirini sunmuyor. Başka bir ajan seçin.`
      );
    }
    const recommended = recommendOrchestraModel(agent.providerId, models, difficulty);
    const suggestion = recommended ? `${recommended.id} (${recommended.name})` : null;
    if (!requested) {
      if (!recommended) {
        throw new Error(
          `${agent.name} için "${difficulty}" zorluğunu karşılayan model yok. Daha güçlü modeli olan başka bir ajan seçin.`
        );
      }
      const model = models.find((candidate) => candidate.id === recommended.id) ?? null;
      return { model, autoSelected: true };
    }
    const usable = usableOrchestraModels(agent.providerId, models);
    const model = models.find((candidate) => candidate.id === requested);
    if (!model) {
      const list = usable.map((candidate) => candidate.id).join(', ');
      if (agent.models.some((candidate) => candidate.id === requested)) {
        throw new Error(`"${requested}" ${agent.name} oturumunda sunulmuyor. Modeller: ${list}`);
      }
      throw new Error(`"${requested}" ${agent.name} için geçerli değil. Modeller: ${list}`);
    }
    const profile = orchestraModelProfile(agent.providerId, model);
    const alternative = suggestion ? ` Bunun yerine: ${suggestion}.` : '';
    if (profile.role === 'excluded') {
      throw new Error(`${model.name} işçi modeli olarak kullanılmaz.${alternative}`);
    }
    if (profile.role === 'legacy' && usable.some((candidate) => candidate.id !== model.id)) {
      throw new Error(`${model.name} eski nesil bir model.${alternative}`);
    }
    if (isReservedForDifficulty(profile, difficulty)) {
      throw new Error(
        `${model.name} yalnızca kritik ("critical") işlerde kullanılır; bu iş "${difficulty}".${alternative}`
      );
    }
    if (difficultyRank(profile.maxDifficulty) < difficultyRank(difficulty)) {
      throw new Error(
        `${model.name} "${difficulty}" zorluğundaki bir iş için yetersiz (en fazla "${profile.maxDifficulty}").${alternative}`
      );
    }
    return { model, autoSelected: false };
  }

  private async spawnAgent(session: SessionRecord, args: Record<string, unknown>) {
    const providerId = requireString(args.agent, 'agent');
    const task = requireString(args.task, 'task');
    const agent = session.settings.workers.find((worker) => worker.providerId === providerId);
    if (!agent) {
      const allowed = session.settings.workers.map((worker) => worker.providerId).join(', ');
      throw new Error(`"${providerId}" bu orkestrada kullanılamaz. Kullanılabilir: ${allowed}`);
    }
    if (!isOrchestraDifficulty(args.difficulty)) {
      throw new Error(`"difficulty" alanı gerekli: ${ORCHESTRA_DIFFICULTIES.join(', ')}.`);
    }
    const difficulty = args.difficulty;
    const requestedModel = typeof args.model === 'string' && args.model.trim() ? args.model : null;
    const models = this.workerModels(session, agent);
    const { model, autoSelected } = this.selectWorkerModel(
      agent,
      models,
      requestedModel,
      difficulty
    );
    const effort = isOrchestraEffort(args.effort) ? args.effort : effortForDifficulty(difficulty);
    const reason = requireString(args.reason, 'reason').trim();
    const modelName = model?.name ?? null;
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
    // Sağlayıcının bu model için kendi kimliği biliniyorsa (ör. "opus[1m]") o kaydedilir;
    // oturum yeniden açıldığında da aynı model uygulanır.
    const liveModel = model ? this.liveOptionFor(session, agent.providerId, model) : null;
    await this.deps.createConversation({
      id: workerId,
      projectId: session.projectId,
      taskId: session.taskId,
      provider: providerId as CreateConversationParams['provider'],
      title: `🎼 ${agent.name}${modelName ? ` · ${modelName}` : ''} · ${title}`.slice(0, 120),
      autoApprove: session.settings.autoApproveWorkers,
      ...(model ? { model: liveModel?.id ?? model.id } : {}),
      type: 'acp',
    });
    const worker: WorkerRecord = {
      workerId,
      providerId,
      agentName: agent.name,
      model: model?.id ?? null,
      title,
      role,
      createdAt: Date.now(),
      lastPromptId: null,
      lastPromptAt: null,
      settled: null,
      modelName,
      reason,
      settledAt: null,
      difficulty,
      effort: null,
      description:
        typeof args.description === 'string' && args.description.trim()
          ? args.description.trim()
          : null,
    };
    session.workers.push(worker);
    await this.persist();

    try {
      await this.startWorker(session, agent, worker, { effort, difficulty, model });
      await this.deliver(worker, task, buildWorkerBrief({ title, role }));
    } catch (error) {
      // Başlatılamayan işçi ne kayıtta ne sohbette kalsın; sohbet satırları işçilerle sırayla eşleşir.
      await this.discardWorker(session, worker);
      throw error;
    }
    const efficient =
      model && difficulty === 'trivial'
        ? recommendOrchestraModel(agent.providerId, models, 'trivial')
        : null;
    return {
      worker_id: workerId,
      agent: providerId,
      model: worker.model ?? 'agent default',
      model_name: worker.modelName ?? worker.model ?? 'agent default',
      model_auto_selected: autoSelected,
      difficulty,
      effort: worker.effort ?? 'provider default',
      title,
      reason,
      status: 'running',
      ...(efficient && model && efficient.id !== model.id
        ? { note: `More efficient for trivial work: ${efficient.id} (${efficient.name}).` }
        : {}),
      hint: 'Spawn other independent workers now, then call wait_for_agents.',
    };
  }

  /**
   * İşçi oturumunu bağlayıp etkinleştirir, istenen modeli uygular, düşünme seviyesini ayarlar ve
   * oturumun gerçekten çalıştırdığı modeli doğrular. İstenen model uygulanamadıysa ya da etkin
   * model ürün kurallarını çiğniyorsa hata fırlatır.
   */
  private async startWorker(
    session: SessionRecord,
    agent: OrchestraWorkerAgent,
    worker: WorkerRecord,
    options: {
      effort: OrchestraEffort;
      difficulty: OrchestraDifficulty;
      model: OrchestraModelInput | null;
    }
  ): Promise<void> {
    const activation = await this.activateWorker(worker.workerId);
    if (!activation.ok) throw new Error(`${agent.name} başlatılamadı: ${activation.reason}`);
    // Model önce uygulanır: model değişince sağlayıcının düşünme seçenekleri de değişebilir.
    let resolved = await this.resolveWorkerModel(session, agent, worker.workerId, options.model);
    if (!resolved.mismatch) {
      worker.effort = await this.applyEffort(worker.workerId, options.effort);
      // Son durum, düşünme seviyesi de ayarlandıktan sonra yeniden doğrulanır.
      resolved = await this.resolveWorkerModel(session, agent, worker.workerId, options.model);
    }
    const problem =
      resolved.mismatch ?? modelRuleViolation(agent, resolved.effective, options.difficulty);
    if (problem) {
      throw new Error(
        `${agent.name} işçisi başlatılmadı ve konuşması kaldırıldı: ${problem} ${this.usableModelsNote(session, agent, options.difficulty)}`
      );
    }
    if (!worker.model && resolved.effective) {
      worker.model = resolved.effective.id;
      worker.modelName = resolved.effective.name;
    }
  }

  /** Oturumu bağlar ve etkinleştirir; model ve düşünme seçenekleri ancak oturum başlayınca bilinir. */
  private async activateWorker(workerId: string): Promise<{ ok: true } | CallFailure> {
    const attached = await settleCall(() => this.deps.attach(workerId));
    if (!attached.ok) return attached;
    // Geçmiş isteği askıdaki oturumu etkinleştirir.
    const history = await settleCall(() => this.deps.loadHistory(workerId, 1));
    return history.ok ? { ok: true } : history;
  }

  /**
   * Oturumun gerçekten çalıştırdığı modeli bulur ve istenen modeli uygular. Sağlayıcılar modelleri
   * kendi kimlikleriyle sunar (Claude: "opus[1m]"); istenen katalog modeli oturumun seçeneğiyle
   * eşlenir ve oturum başka bir modeldeyse o seçenek uygulanır. Sağlayıcı modeli hiç sunmuyorsa
   * (hesap kademesi, eski uzak CLI) oturum sessizce varsayılanla açılmıştır; bu `mismatch` döner.
   */
  private async resolveWorkerModel(
    session: SessionRecord,
    agent: OrchestraWorkerAgent,
    workerId: string,
    requested: OrchestraModelInput | null
  ): Promise<{ effective: OrchestraLiveModelOption | null; mismatch: string | null }> {
    let read = await this.readWorkerModel(workerId);
    if (read.state && read.state.available.length > 0) {
      this.rememberLiveModels(session, agent.providerId, read.state.available);
    }
    if (!requested) return { effective: selectedOption(read.state), mismatch: null };
    if (!read.state) {
      return {
        effective: null,
        mismatch: read.error
          ? `${agent.name} oturumunun etkin modeli doğrulanamadı (${read.error}).`
          : `${agent.name} oturumu model seçimi sunmuyor; ${requested.name} uygulanamadı.`,
      };
    }
    // Seçenek listesi bildirmeyen sağlayıcıda yalnızca seçili model karşılaştırılabilir.
    const offered =
      read.state.available.length > 0 ? read.state.available : selectedOptions(read.state);
    const target = findLiveModelOption(requested, offered);
    if (!target) {
      const current = selectedOption(read.state);
      return {
        effective: current,
        mismatch: `${agent.name} oturumu ${requested.name} modelini sunmuyor${current ? `; oturum ${current.name} ile açıldı` : ''}.`,
      };
    }
    if (
      !sameModel(read.state.selected ?? '', target.id) &&
      (await this.applyModel(workerId, target.id))
    ) {
      read = await this.readWorkerModel(workerId);
    }
    const current = selectedOption(read.state);
    if (!current || !sameModel(current.id, target.id)) {
      return {
        effective: current,
        mismatch: `${requested.name} istendi ama ${agent.name} oturumu bu modele geçmedi${current ? `; oturum ${current.name} ile çalışıyor` : ''}.`,
      };
    }
    return { effective: current, mismatch: null };
  }

  private async readWorkerModel(
    workerId: string
  ): Promise<{ state: WorkerModelState | null; error: string | null }> {
    try {
      return { state: await this.deps.sessionModel(workerId), error: null };
    } catch (error) {
      const reason = describeError(error);
      this.deps.logger.warn('Orkestra: işçinin etkin modeli okunamadı', {
        worker: workerId,
        error: reason,
      });
      return { state: null, error: reason };
    }
  }

  /** Oturumun modelini sağlayıcının kendi kimliğiyle değiştirir; uygulanamazsa false döner. */
  private async applyModel(workerId: string, model: string): Promise<boolean> {
    if (!this.deps.setModel) return false;
    try {
      return await this.deps.setModel(workerId, model);
    } catch (error) {
      this.deps.logger.warn('Orkestra: işçi modeli uygulanamadı', {
        worker: workerId,
        model,
        error: String(error),
      });
      return false;
    }
  }

  private liveModelKey(session: SessionRecord, providerId: string): string {
    return `${session.conversationId}\u0000${providerId}`;
  }

  /** Sağlayıcı oturumunun sunduğu modelleri hatırlar; sonraki seçimler bunlarla sınırlanır. */
  private rememberLiveModels(
    session: SessionRecord,
    providerId: string,
    available: readonly OrchestraLiveModelOption[]
  ): void {
    this.liveModels.set(this.liveModelKey(session, providerId), [...available]);
  }

  /** Katalog modelinin oturumdaki karşılığı; oturumun sunduğu modeller henüz bilinmiyorsa null. */
  private liveOptionFor(
    session: SessionRecord,
    providerId: string,
    model: OrchestraModelInput
  ): OrchestraLiveModelOption | null {
    const live = this.liveModels.get(this.liveModelKey(session, providerId));
    return live ? findLiveModelOption(model, live) : null;
  }

  /** Şefin seçebileceği modeller: ayarlardaki katalog, oturumun sunduğu modellerle kesiştirilir. */
  private workerModels(
    session: SessionRecord,
    agent: OrchestraWorkerAgent
  ): OrchestraWorkerAgent['models'] {
    const live = this.liveModels.get(this.liveModelKey(session, agent.providerId));
    if (!live) return agent.models;
    return agent.models.filter((model) => findLiveModelOption(model, live) !== null);
  }

  /** Şefin yeniden deneyebileceği modeller; uygun model yoksa başka bir ajan önerir. */
  private usableModelsNote(
    session: SessionRecord,
    agent: OrchestraWorkerAgent,
    difficulty: OrchestraDifficulty
  ): string {
    const usable = capableOrchestraModels(
      agent.providerId,
      this.workerModels(session, agent),
      difficulty
    );
    if (usable.length === 0) {
      return `${agent.name} bu oturumda "${difficulty}" zorluğuna uygun bir model sunmuyor; başka bir ajan seçin.`;
    }
    const list = usable.map((model) => `${model.id} (${model.name})`).join(', ');
    return `Bu iş için kullanılabilir ${agent.name} modelleri: ${list}.`;
  }

  /** Başlatılamayan işçiyi kayıttan ve sohbetten (canlı oturumuyla birlikte) kaldırır. */
  private async discardWorker(session: SessionRecord, worker: WorkerRecord): Promise<void> {
    const index = session.workers.indexOf(worker);
    if (index >= 0) session.workers.splice(index, 1);
    this.unresolvedSince.delete(worker.workerId);
    await this.persist();
    try {
      await this.deps.deleteConversation({
        projectId: session.projectId,
        taskId: session.taskId,
        conversationId: worker.workerId,
      });
    } catch (error) {
      this.deps.logger.warn('Orkestra: başlatılamayan işçinin konuşması silinemedi', {
        worker: worker.workerId,
        error: String(error),
      });
    }
  }

  /** Düşünme seviyesini sağlayıcının en yakın seçeneğine ayarlar; oturum etkin olmalıdır. */
  private async applyEffort(
    conversationId: string,
    effort: OrchestraEffort
  ): Promise<string | null> {
    if (!this.deps.setEffort) return null;
    try {
      return await this.deps.setEffort(conversationId, effort);
    } catch (error) {
      this.deps.logger.warn('Orkestra: düşünme seviyesi ayarlanamadı', {
        conversationId,
        error: String(error),
      });
      return null;
    }
  }

  private async messageAgent(session: SessionRecord, args: Record<string, unknown>) {
    const worker = requireWorker(session, args.worker_id);
    const message = requireString(args.message, 'message');
    const activation = await this.activateWorker(worker.workerId);
    if (!activation.ok) throw new Error(`İşçiye ulaşılamadı: ${activation.reason}`);
    // Oturum yeniden açıldıysa sağlayıcı modeli düşürmüş olabilir: model yeniden uygulanır, işçi
    // kurala aykırı bir modelle sürmez; kurala uygun başka bir modelde kaldıysa kayıt güncellenir.
    const agent = session.settings.workers.find(
      (candidate) => candidate.providerId === worker.providerId
    ) ?? { providerId: worker.providerId, name: worker.agentName, models: [] };
    const requested = worker.model
      ? (agent.models.find((model) => model.id === worker.model) ?? {
          id: worker.model,
          name: worker.modelName ?? worker.model,
        })
      : null;
    const resolved = await this.resolveWorkerModel(session, agent, worker.workerId, requested);
    const violation = modelRuleViolation(agent, resolved.effective, worker.difficulty ?? null);
    if (violation) {
      throw new Error(`İşçiye mesaj gönderilmedi: ${violation} Yeni bir işçi başlatın.`);
    }
    if (resolved.mismatch && resolved.effective) {
      worker.model = resolved.effective.id;
      worker.modelName = resolved.effective.name;
    }
    await this.deliver(worker, message);
    return {
      worker_id: worker.workerId,
      status: 'running',
      ...(resolved.mismatch ? { note: resolved.mismatch } : {}),
    };
  }

  private async deliver(worker: WorkerRecord, text: string, hiddenContext?: string): Promise<void> {
    const promptId = randomUUID();
    const sent = await settleCall(() =>
      this.deps.sendPrompt({
        conversationId: worker.workerId,
        promptId,
        prompt: { text, ...(hiddenContext ? { hiddenContext } : {}) },
      })
    );
    if (!sent.ok) throw new Error(`İstem gönderilemedi: ${sent.reason}`);
    worker.lastPromptId = promptId;
    worker.lastPromptAt = Date.now();
    worker.lastPromptText = promptFingerprint(text);
    worker.settled = null;
    worker.settledAt = null;
    worker.report = null;
    worker.errorMessage = null;
    delete worker.lost;
    this.unresolvedSince.delete(worker.workerId);
    await this.persist();
    this.ensurePermissionWatcher();
  }

  /**
   * İşçinin turunu gerçekten durdurur: kuyruktaki istemleri siler (iptal edilen turun ardından
   * işçiyi yeniden başlatmasınlar), turu iptal eder ve oturum durana kadar bekler. Sağlayıcı
   * iptale uymazsa oturumu sonlandırır. Sonuç kayda yazılır.
   */
  private async cancelAgent(session: SessionRecord, worker: WorkerRecord) {
    if (!worker.lastPromptId || worker.settled !== null) {
      const state = await this.workerState(session, worker);
      return {
        worker_id: worker.workerId,
        cancelled: false,
        status: state.status,
        note: 'İşçinin çalışan bir görevi yok.',
      };
    }
    const before = await this.deps.sessionState(worker.workerId);
    const live = before !== null && !before.suspended && before.lifecycle !== 'closed';
    for (const id of before?.queuedPromptIds ?? []) {
      const removed = await settleCall(() =>
        this.deps.deleteQueuedPrompt({ conversationId: worker.workerId, id })
      );
      if (!removed.ok) {
        this.deps.logger.warn('Orkestra: işçinin kuyruktaki istemi silinemedi', {
          worker: worker.workerId,
          error: removed.reason,
        });
      }
    }
    const cancelled = await settleCall(() => this.deps.cancelTurn(worker.workerId));
    let terminated = false;
    if (!(await this.waitUntilStopped(worker.workerId))) {
      // Sağlayıcı iptale uymadı: işçi ortak worktree'de çalışmayı sürdürmesin diye oturumu kapat.
      const result = await settleCall(() => this.deps.terminate(worker.workerId));
      if (!result.ok) {
        throw new Error(
          `İşçi durdurulamadı: ${cancelled.ok ? result.reason : `${cancelled.reason}; ${result.reason}`}`
        );
      }
      terminated = true;
    }
    // Duran canlı oturumda iptal edilen turun kısmi çıktısı rapor olarak saklanır. Tur iptalden
    // hemen önce bittiyse gerçek sonucu yazılır.
    const observed = live && !terminated ? await this.observeTurn(worker) : null;
    if (worker.settled === null) {
      const outcome =
        observed && observed.status !== 'lost'
          ? observed
          : { status: 'cancelled' as const, report: observed?.report ?? null, errorMessage: null };
      await this.settle(session, worker, outcome);
    }
    const final = settledState(worker);
    return {
      worker_id: worker.workerId,
      cancelled: final.status === 'cancelled',
      status: final.status,
      ...(terminated
        ? {
            note: 'İşçi iptale yanıt vermediği için oturumu sonlandırıldı; message_agent ile yeniden kullanılabilir.',
          }
        : {}),
    };
  }

  /** İptalden sonra oturumun durmasını bekler; süre dolarken hâlâ çalışıyorsa false döner. */
  private async waitUntilStopped(conversationId: string): Promise<boolean> {
    const deadline = Date.now() + (this.deps.timing?.cancelGraceMs ?? CANCEL_GRACE_MS);
    for (;;) {
      const state = await this.deps.sessionState(conversationId);
      if (!state || !isBusy(state)) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(CANCEL_POLL_MS, remaining));
    }
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

  /**
   * İşçinin son isteminin durumu. Kesinleşen sonuç (rapor dahil) ilk gözlendiğinde kayda yazılır;
   * sonraki okumalar geçmişi yeniden yüklemez, böylece oturum kapansa da sonuç kaybolmaz.
   */
  private async workerState(session: SessionRecord, worker: WorkerRecord): Promise<WorkerState> {
    if (!worker.lastPromptId) return { status: 'starting', report: null, errorMessage: null };
    if (worker.settled !== null) return settledState(worker);
    const promptId = worker.lastPromptId;
    const observed = await this.observeTurn(worker);
    if (worker.settled !== null) return settledState(worker);
    // Gözlem sürerken yeni bir istem gönderildiyse eski tur yeni istemi kesinleştirmesin.
    if (observed && worker.lastPromptId === promptId) {
      await this.settle(session, worker, observed);
      return settledState(worker);
    }
    const pending = await this.pendingAfterAutoApprove(session, worker.workerId);
    return {
      status: pending > 0 ? 'awaiting-permission' : 'running',
      report: null,
      errorMessage: null,
    };
  }

  /**
   * Son istemin turunu geçmişte arar. Tur bittiyse ya da sonucu belirlenemiyorsa kesin durumu,
   * hâlâ sürüyorsa null döndürür.
   */
  private async observeTurn(worker: WorkerRecord): Promise<WorkerState | null> {
    const history = await this.readHistory(worker.workerId);
    if (!history.ok) {
      if (history.missing) {
        return lostState(`İşçi konuşması bulunamadı (silinmiş olabilir). ${LOST_HINT}`);
      }
      return this.lostAfterGrace(
        worker.workerId,
        `İşçinin oturumuna ulaşılamadı (${history.reason}). ${LOST_HINT}`
      );
    }
    // Canlı oturumda tur, istem kimliğiyle kesin olarak bulunur.
    const live = history.turns.find((turn) =>
      turn.items.some((item) => isUserMessage(item) && item.promptId === worker.lastPromptId)
    );
    if (live?.outcome) return outcomeState(live, live.outcome);
    // Oturum yeniden açıldıysa (uygulama yeniden başladı, boşta kapatıldı, çöktü) geçmiş istem
    // kimliği ve tur sonucu olmadan yeniden oynatılır; tur istem metninden bulunur. Önceki
    // etkinleşmeye ait bir tur artık çalışıyor olamaz.
    const replayed = live ?? findReplayedTurn(history.turns, worker.lastPromptText);
    if (replayed) return replayedState(replayed);
    const state = await this.deps.sessionState(worker.workerId);
    if (!state) {
      return this.lostAfterGrace(worker.workerId, `İşçi oturumunun durumu okunamadı. ${LOST_HINT}`);
    }
    if (isBusy(state)) {
      // Tur sürüyor ya da istem kuyrukta.
      this.unresolvedSince.delete(worker.workerId);
      return null;
    }
    return lostState(`İşçinin son görevi oturum geçmişinde bulunamadı. ${LOST_HINT}`);
  }

  /**
   * İşçinin geçmişini okur. Uygulama yeniden başladıysa çalışma zamanı işçiyi henüz tanımıyor
   * olabilir ("not attached"): oturum bir kez yeniden bağlanıp geçmiş tekrar istenir.
   */
  private async readHistory(workerId: string): Promise<HistoryRead> {
    const first = await this.tryLoadHistory(workerId);
    if (first.ok || first.missing) return first;
    const attached = await settleCall(() => this.deps.attach(workerId));
    if (!attached.ok) return attached;
    return this.tryLoadHistory(workerId);
  }

  private async tryLoadHistory(workerId: string): Promise<HistoryRead> {
    const result = await settleCall(() => this.deps.loadHistory(workerId, HISTORY_TURNS));
    if (!result.ok) return result;
    if (result.data.unavailable) {
      return { ok: false, reason: 'oturum geçmişi şu an alınamıyor', missing: false };
    }
    return { ok: true, turns: result.data.turns };
  }

  /** Belirlenemeyen durum kısa bir süre sürerse işçi kayıp sayılır; geçici kopmalar affedilir. */
  private lostAfterGrace(workerId: string, message: string): WorkerState | null {
    const now = Date.now();
    const since = this.unresolvedSince.get(workerId) ?? now;
    this.unresolvedSince.set(workerId, since);
    const grace = this.deps.timing?.lostGraceMs ?? LOST_GRACE_MS;
    return now - since >= grace ? lostState(message) : null;
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
    // SSH yeniden bağlandıysa uzak şeflerin tünelini aynı soket yoluna yeniden kur.
    await this.remote?.refresh();
    let active = this.remote?.activeCount() ?? 0;
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

  /** Kesinleşen durumu raporuyla birlikte kayda yazar; ilk gözlem kazanır. */
  private async settle(
    session: SessionRecord,
    worker: WorkerRecord,
    state: WorkerState
  ): Promise<void> {
    const status = state.status;
    if (worker.settled !== null || !isTerminal(status)) return;
    const lost = status === 'lost';
    worker.settled = lost ? 'error' : status;
    if (lost) worker.lost = true;
    else delete worker.lost;
    worker.report = clampStoredReport(state.report);
    worker.errorMessage = state.errorMessage;
    worker.settledAt = Date.now();
    this.unresolvedSince.delete(worker.workerId);
    // Kayıp işçiler (yeniden başlatma, silinen konuşma) sağlayıcının başarı istatistiğini bozmaz.
    if (!lost) {
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
    }
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
    modelName: worker.modelName ?? null,
    reason: worker.reason ?? null,
    difficulty: worker.difficulty ?? null,
    effort: worker.effort ?? null,
    description: worker.description ?? null,
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
    model_name: worker.modelName ?? worker.model ?? 'default',
    title: worker.title,
    role: worker.role,
    reason: worker.reason ?? null,
    difficulty: worker.difficulty ?? null,
    effort: worker.effort ?? null,
    status: state.status,
    ...(worker.lastPromptAt
      ? {
          elapsed_minutes:
            Math.round((((worker.settledAt ?? Date.now()) - worker.lastPromptAt) / 60_000) * 10) /
            10,
        }
      : {}),
    ...(state.status === 'awaiting-permission'
      ? {
          note: `Waiting for the user to approve a permission in the "${worker.title}" conversation.`,
        }
      : {}),
    ...(state.errorMessage ? { error: state.errorMessage } : {}),
    report,
  };
}

/** Kayda yazılmış kesin durum. */
function settledState(worker: WorkerRecord): WorkerState {
  return {
    status: worker.lost ? 'lost' : (worker.settled ?? 'running'),
    report: worker.report ?? null,
    errorMessage: worker.errorMessage ?? null,
  };
}

function lostState(message: string): WorkerState {
  return { status: 'lost', report: null, errorMessage: message };
}

function isUserMessage(item: TurnItemLike): boolean {
  return item.kind === 'message' && item.role === 'user';
}

function assistantText(turn: TurnLike): string | null {
  const text = turn.items
    .filter((item) => item.kind === 'message' && item.role === 'assistant' && item.text)
    .map((item) => item.text)
    .join('\n\n')
    .trim();
  return text || null;
}

/** Canlı (istem kimliği taşıyan) turun açık sonucu. */
function outcomeState(turn: TurnLike, outcome: NonNullable<TurnLike['outcome']>): WorkerState {
  const report = assistantText(turn);
  switch (outcome.kind) {
    case 'done':
      return { status: 'done', report, errorMessage: null };
    case 'cancelled':
      return { status: 'cancelled', report, errorMessage: null };
    case 'interrupted':
      return {
        status: 'lost',
        report,
        errorMessage: `İşçinin turu yarıda kesildi (${outcome.reason ?? 'oturum kapandı'}).${report ? ' Kısmi çıktı raporda.' : ''} ${LOST_HINT}`,
      };
    default:
      return {
        status: 'error',
        report,
        errorMessage: outcome.message ?? outcome.reason ?? outcome.kind,
      };
  }
}

/**
 * Yeniden oynatılmış turun sonucu. Tur önceki bir etkinleşmeye aittir, artık çalışıyor olamaz:
 * işçinin son sözü bir yanıtsa tamamlanmış, değilse (araç çağrısında kalmışsa) yarıda kesilmiş
 * sayılır.
 */
function replayedState(turn: TurnLike): WorkerState {
  const report = assistantText(turn);
  const last = turn.items.at(-1);
  const answered =
    last !== undefined &&
    last.kind === 'message' &&
    last.role === 'assistant' &&
    Boolean(last.text?.trim());
  if (answered) return { status: 'done', report, errorMessage: null };
  return {
    status: 'lost',
    report,
    errorMessage: `İşçinin turu yarıda kesilmiş görünüyor; oturum yeniden açıldığı için tamamlandığı doğrulanamadı.${report ? ' Kısmi çıktı raporda.' : ''} ${LOST_HINT}`,
  };
}

/**
 * İstem kimliği taşımayan (yeniden oynatılmış) turlar arasında son istemin turunu, görünen
 * metninin özetiyle en yeniden eskiye doğru arar. Kimlik taşıyan turlar canlı etkinleşmeye aittir
 * ve kimlik eşleşmediyse bu isteme ait değildir.
 */
function findReplayedTurn(
  turns: readonly TurnLike[],
  fingerprint: string | null | undefined
): TurnLike | null {
  const replayed = turns.filter((turn) =>
    turn.items.some((item) => isUserMessage(item) && !item.promptId)
  );
  // Önceki sürümlerin kayıtlarında metin özeti yok: son yeniden oynatılmış kullanıcı turu en
  // iyi tahmindir.
  if (fingerprint === undefined) return replayed.at(-1) ?? null;
  if (!fingerprint) return null;
  for (let index = replayed.length - 1; index >= 0; index -= 1) {
    const turn = replayed[index]!;
    const text = normalizePromptText(
      turn.items
        .filter(isUserMessage)
        .map((item) => item.text ?? '')
        .join(' ')
    );
    if (text.includes(fingerprint)) return turn;
  }
  return null;
}

function normalizePromptText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function promptFingerprint(text: string): string | null {
  return normalizePromptText(text).slice(0, PROMPT_FINGERPRINT_CHARS) || null;
}

function clampStoredReport(report: string | null): string | null {
  if (!report || report.length <= MAX_STORED_REPORT_CHARS) return report;
  return `${report.slice(0, MAX_STORED_REPORT_CHARS)}\n…[kısaltıldı]`;
}

/** Oturum hâlâ çalışıyor mu: tur sürüyor, başlıyor/iptal ediliyor ya da kuyrukta istem var. */
function isBusy(state: WorkerSessionState): boolean {
  if (state.suspended) return false;
  return (
    BUSY_LIFECYCLES.has(state.lifecycle) || state.isGenerating || state.queuedPromptIds.length > 0
  );
}

/**
 * Etkin model ürün kurallarını çiğniyorsa açıklaması; uygunsa ya da bilinmiyorsa null. Seçenek
 * bir katalog modeline karşılık geliyorsa onun profili de denetlenir; karşılığı olmayan takma
 * adların ("default") hangi modele çözüldüğü yalnızca açıklamada yazar.
 */
function modelRuleViolation(
  agent: OrchestraWorkerAgent,
  effective: OrchestraLiveModelOption | null,
  difficulty: OrchestraDifficulty | null
): string | null {
  if (!effective) return null;
  const catalogModel = findCatalogModel(agent.models, effective);
  const label =
    !catalogModel && effective.description
      ? `${effective.name} — ${effective.description}`
      : effective.name;
  const profiles = [orchestraModelProfile(agent.providerId, { id: effective.id, name: label })];
  if (catalogModel) profiles.push(orchestraModelProfile(agent.providerId, catalogModel));
  const opened = `${agent.name} oturumu ${catalogModel?.name ?? label} ile açıldı`;
  if (profiles.some((profile) => profile.role === 'excluded')) {
    return `${opened}; bu model işçi olarak hiçbir zaman kullanılmaz.`;
  }
  if (difficulty && profiles.some((profile) => isReservedForDifficulty(profile, difficulty))) {
    return `${opened}; bu model yalnızca kritik işlerde kullanılır.`;
  }
  return null;
}

function selectedOptions(state: WorkerModelState | null): OrchestraLiveModelOption[] {
  const selected = selectedOption(state);
  return selected ? [selected] : [];
}

/** Oturumun seçili modeli; sunduğu seçeneklerdeki adı ve açıklamasıyla. */
function selectedOption(state: WorkerModelState | null): OrchestraLiveModelOption | null {
  if (!state?.selected) return null;
  const selected = state.selected;
  return (
    state.available.find((option) => sameModel(option.id, selected)) ?? {
      id: selected,
      name: selected,
    }
  );
}

function sameModel(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
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

function isTerminal(status: OrchestraWorkerStatus): status is TerminalStatus {
  return status === 'done' || status === 'error' || status === 'cancelled' || status === 'lost';
}

function summarizeTitle(task: string): string {
  const line = task.trim().split('\n')[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'Görev';
}

/** Result döndüren ya da fırlatan bir bağımlılık çağrısını tek biçime indirger. */
async function settleCall<T>(
  call: () => Promise<Result<T, unknown>>
): Promise<{ ok: true; data: T } | CallFailure> {
  try {
    const result = await call();
    return result.success ? { ok: true, data: result.data } : callFailure(result.error);
  } catch (error) {
    return callFailure(error);
  }
}

function callFailure(error: unknown): CallFailure {
  return { ok: false, reason: describeError(error), missing: isMissingConversation(error) };
}

/** Konuşma silinmiş ya da hiç yok: denetleyici kaydı bulamadı veya çalışma zamanı tanımıyor. */
function isMissingConversation(error: unknown): boolean {
  if ((error as { type?: unknown } | null)?.type === 'conversation_not_found') return true;
  return /conversation '[^']*' was not found|conversation was deleted/i.test(describeError(error));
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; type?: unknown; cause?: { message?: unknown } };
    if (record.type === 'conversation_not_found') return 'konuşma bulunamadı';
    if (typeof record.message === 'string') return record.message;
    if (typeof record.type === 'string') {
      return typeof record.cause?.message === 'string'
        ? `${record.type}: ${record.cause.message}`
        : record.type;
    }
  }
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
