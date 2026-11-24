import { mkdir } from 'node:fs/promises';
// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/workflows/WorkflowRuntime.ts
//
// Kod iş akışlarının ana süreç servisi: ayar açıkken klasörü izler, tanımları motora verir,
// kancaları webhook sunucusuna bağlar. Kapalıyken klasördeki hiçbir şey çalışmaz; çalıştırmalar
// diskte kalır ve özellik yeniden açılınca sürer.
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Logger } from '@orkestra/shared/logger';
import type {
  CodeWorkflowActionResult,
  CodeWorkflowEntry,
  CodeWorkflowHook,
  CodeWorkflowRun,
  CodeWorkflowStatus,
} from '../contract';
import type { WebhookRequest } from './authoring';
import {
  WorkflowEngine,
  type AgentStepExecutor,
  type LoadedDefinition,
  type PollSources,
} from './engine';
import { DEFINITION_FILE, WorkflowFolder, type DefinitionProblem } from './loader';
import { WorkflowRunStore } from './store';
import { describeSchedule } from './triggers';

/** Klasör (ya da tek dosya) için ortam değişkeni; yoksa `~/.orkestra/workflows`. */
export const WORKFLOWS_ENV = 'ORKESTRA_WORKFLOWS';

export function defaultWorkflowsFolder(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[WORKFLOWS_ENV]?.trim();
  return override || join(homedir(), '.orkestra', 'workflows');
}

export type WorkflowHookServer = {
  setWorkflowHookHandler(
    handler:
      | ((input: {
          workflow: string;
          hook: string;
          secret: string;
          request: WebhookRequest;
        }) => Promise<{ status: number; body: unknown }>)
      | null
  ): void;
  getWorkflowHookUrl(workflow: string, hook: string): Promise<string>;
};

export type CodeWorkflowServiceOptions = {
  /** Çalıştırma kayıtları `<dataDirectory>/workflows/` altında tutulur. */
  dataDirectory: string;
  folder: string;
  logger: Pick<Logger, 'info' | 'warn'>;
  agents: AgentStepExecutor;
  isEnabled(): Promise<boolean>;
  pollSources?: PollSources;
  hooks?: WorkflowHookServer;
  onQuestion?(run: CodeWorkflowRun, entry: CodeWorkflowEntry): void;
  openPath?(path: string): Promise<string>;
  /** Testler için motor ayarları. */
  engine?: { autoTick?: boolean; now?: () => number };
};

const OFF_ERROR = 'Workflows are off. Turn them on in Settings → General → Workflows.';

export class CodeWorkflowService {
  private engine: WorkflowEngine | null = null;
  private folder: WorkflowFolder | null = null;
  private problems: DefinitionProblem[] = [];
  private readonly store: WorkflowRunStore;
  private transition: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: CodeWorkflowServiceOptions) {
    this.store = new WorkflowRunStore(
      join(options.dataDirectory, 'workflows'),
      (message, context) => options.logger.warn(message, context)
    );
  }

  /** Ayarı okuyup motoru açar ya da kapatır; ayar değişince yeniden çağrılır. */
  refresh(): Promise<void> {
    this.transition = this.transition
      .then(async () => {
        if (this.disposed) return;
        const enabled = await this.options.isEnabled().catch(() => false);
        if (enabled && !this.engine) await this.turnOn();
        else if (!enabled && this.engine) await this.turnOff();
      })
      .catch((error: unknown) => {
        this.options.logger.warn('Workflows: could not apply the setting', {
          error: String(error),
        });
      });
    return this.transition;
  }

  private async turnOn(): Promise<void> {
    const engine = new WorkflowEngine({
      store: this.store,
      agents: this.options.agents,
      logger: this.options.logger,
      ...(this.options.pollSources ? { pollSources: this.options.pollSources } : {}),
      ...(this.options.engine?.now ? { now: this.options.engine.now } : {}),
      ...(this.options.engine?.autoTick === false ? { autoTick: false } : {}),
      onQuestion: (run, entry) => this.options.onQuestion?.(run, entry),
    });
    this.engine = engine;
    const folder = new WorkflowFolder(this.options.folder, {
      logger: this.options.logger,
      ensureDirectory: async (directory) => {
        await mkdir(directory, { recursive: true }).catch(() => undefined);
      },
      onChange: (definitions: LoadedDefinition[], problems) => {
        this.problems = problems;
        if (this.engine === engine) engine.setDefinitions(definitions);
      },
    });
    this.folder = folder;
    // Tanımlar önce yüklenir ki yarım kalan çalıştırmalar sürümlerini bulup hemen sürsün.
    await folder.start();
    await engine.start();
    this.options.hooks?.setWorkflowHookHandler((input) =>
      this.engine
        ? this.engine.handleWebhook(input)
        : Promise.resolve({ status: 404, body: { error: 'Not found' } })
    );
  }

  private async turnOff(): Promise<void> {
    this.options.hooks?.setWorkflowHookHandler(null);
    this.folder?.stop();
    this.folder = null;
    const engine = this.engine;
    this.engine = null;
    this.problems = [];
    await engine?.dispose();
  }

  async dispose(): Promise<void> {
    await this.transition;
    this.disposed = true;
    await this.turnOff();
  }

  /** Testler ve kancalar için: açıksa motor. */
  get activeEngine(): WorkflowEngine | null {
    return this.engine;
  }

  /** Klasörü hemen yeniden okur (testler; izleyici zaten bunu yapar). */
  async reloadDefinitions(): Promise<void> {
    await this.folder?.reload();
  }

  // ── Okuma ─────────────────────────────────────────────────────────────────

  async status(): Promise<CodeWorkflowStatus> {
    await this.transition;
    const engine = this.engine;
    const folder = this.folder?.folder ?? this.options.folder;
    if (!engine) return { enabled: false, folder, definitions: [], problems: [] };
    const latest = new Set(
      engine.latestDefinitions().map(({ definition }) => `${definition.name}@${definition.version}`)
    );
    return {
      enabled: true,
      folder,
      definitions: engine
        .listDefinitions()
        .map(({ definition, file }) => ({
          name: definition.name,
          version: definition.version,
          file,
          description: definition.description,
          latest: latest.has(`${definition.name}@${definition.version}`),
          triggers: definition.triggers.map((trigger) => {
            switch (trigger.kind) {
              case 'schedule':
                return {
                  kind: 'schedule' as const,
                  label: describeSchedule(trigger.schedule),
                  nextAt: engine.nextScheduleAt(definition.name, trigger.id),
                };
              case 'webhook':
                return { kind: 'webhook' as const, label: `webhook ${trigger.name}`, nextAt: null };
              case 'issues':
                return {
                  kind: 'issues' as const,
                  label: `new issues in ${trigger.project}`,
                  nextAt: null,
                };
              case 'pull-requests':
                return {
                  kind: 'pull-requests' as const,
                  label: `new pull requests in ${trigger.project}`,
                  nextAt: null,
                };
            }
          }),
        }))
        .sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version),
      problems: this.problems,
    };
  }

  async listRuns(limit = 200): Promise<CodeWorkflowRun[]> {
    await this.transition;
    if (this.engine) return this.engine.listRuns(limit);
    // Kapalıyken çalıştırmalar salt okunur olarak listelenir.
    const runs = await this.store.loadRuns();
    return runs.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async getRun(runId: string): Promise<CodeWorkflowRun | null> {
    await this.transition;
    if (this.engine) return this.engine.getRun(runId);
    return (await this.store.loadRuns()).find((run) => run.id === runId) ?? null;
  }

  // ── Eylemler ──────────────────────────────────────────────────────────────

  async start(input: {
    workflow: string;
    input: string;
    key?: string;
  }): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
    await this.transition;
    if (!this.engine) return { ok: false, error: OFF_ERROR };
    let payload: unknown = null;
    if (input.input.trim()) {
      try {
        payload = JSON.parse(input.input);
      } catch (error) {
        return { ok: false, error: `The input is not valid JSON: ${String(error)}` };
      }
    }
    const started = await this.engine.startRun(input.workflow, payload, {
      ...(input.key ? { key: input.key } : {}),
      trigger: { kind: 'manual' },
    });
    return started.ok ? { ok: true, runId: started.runId } : started;
  }

  private async act(
    work: (engine: WorkflowEngine) => Promise<CodeWorkflowActionResult>
  ): Promise<CodeWorkflowActionResult> {
    await this.transition;
    return this.engine ? work(this.engine) : { ok: false, error: OFF_ERROR };
  }

  answer(input: { runId: string; name: string; choice: string; reason?: string }) {
    return this.act((engine) => engine.answer(input.runId, input.name, input.choice, input.reason));
  }

  pause(runId: string) {
    return this.act((engine) => engine.pause(runId));
  }

  resume(runId: string) {
    return this.act((engine) => engine.resume(runId));
  }

  cancel(runId: string, reason?: string) {
    return this.act((engine) => engine.cancel(runId, reason));
  }

  async hooks(): Promise<CodeWorkflowHook[]> {
    await this.transition;
    const engine = this.engine;
    const server = this.options.hooks;
    if (!engine || !server) return [];
    const hooks: CodeWorkflowHook[] = [];
    for (const { definition } of engine.latestDefinitions()) {
      for (const trigger of definition.triggers) {
        if (trigger.kind !== 'webhook') continue;
        hooks.push({
          workflow: definition.name,
          hook: trigger.name,
          url: await server.getWorkflowHookUrl(definition.name, trigger.name),
        });
      }
    }
    return hooks;
  }

  async openFolder(): Promise<CodeWorkflowActionResult> {
    const configured = this.options.folder;
    const folder =
      this.folder?.directory ??
      (DEFINITION_FILE.test(basename(configured)) ? dirname(configured) : configured);
    await mkdir(folder, { recursive: true }).catch(() => undefined);
    if (!this.options.openPath) return { ok: false, error: 'Opening folders is not available.' };
    const error = await this.options.openPath(folder);
    return error ? { ok: false, error } : { ok: true };
  }
}

/** Masaüstü ana sürecinin kod iş akışlarına verdiği bağlantılar (ayar, kancalar, bildirim). */
export type CodeWorkflowsHostOptions = {
  folder: string;
  isEnabled(): Promise<boolean>;
  /** Ayar değişince çağrılır; aboneliği kaldıran işlevi döner. */
  onSettingsChanged(listener: () => void): () => void;
  pollSources?: PollSources;
  hooks?: WorkflowHookServer;
  onQuestion?(run: CodeWorkflowRun, entry: CodeWorkflowEntry): void;
  openPath?(path: string): Promise<string>;
};

/**
 * Konuşmalar denetleyicisinin, adım tabanlı iş akışlarıyla aynı işçi portunu kullanarak kurduğu
 * servis. Ayar değişikliklerini dinler ve kapsam kapanırken motoru durdurur.
 */
export function createHostedCodeWorkflowService(input: {
  host: CodeWorkflowsHostOptions;
  dataDirectory: string;
  logger: Pick<Logger, 'info' | 'warn'>;
  agents: AgentStepExecutor;
  scope: { add(dispose: () => unknown): unknown };
}): CodeWorkflowService {
  const service = new CodeWorkflowService({
    dataDirectory: input.dataDirectory,
    folder: input.host.folder,
    logger: input.logger,
    agents: input.agents,
    isEnabled: () => input.host.isEnabled(),
    ...(input.host.pollSources ? { pollSources: input.host.pollSources } : {}),
    ...(input.host.hooks ? { hooks: input.host.hooks } : {}),
    ...(input.host.onQuestion ? { onQuestion: input.host.onQuestion } : {}),
    ...(input.host.openPath ? { openPath: input.host.openPath } : {}),
  });
  const unsubscribe = input.host.onSettingsChanged(() => void service.refresh());
  void service.refresh();
  input.scope.add(async () => {
    unsubscribe();
    await service.dispose();
  });
  return service;
}
