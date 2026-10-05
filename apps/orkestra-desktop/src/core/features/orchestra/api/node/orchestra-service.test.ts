import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok } from '@orkestra/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestraSettings } from '@core/features/orchestra/api/orchestra';
import type { CreateConversationParams } from '@core/primitives/conversations/api';
import {
  OrchestraService,
  type OrchestraServiceDeps,
  type WorkerSessionState,
} from './orchestra-service';

const settings: OrchestraSettings = {
  conductorProviderId: 'claude',
  conductorModel: null,
  workers: [
    {
      providerId: 'codex',
      name: 'Codex',
      models: [
        { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', intelligence: 5, speed: 4 },
        { id: 'gpt-6-astra', name: 'GPT-6 Astra', intelligence: 5, speed: 3 },
        { id: 'gpt-6-luna', name: 'GPT-6 Luna', intelligence: 4, speed: 5 },
      ],
    },
    { providerId: 'claude', name: 'Claude Code', models: [] },
  ],
  maxParallel: 0,
  autoApproveWorkers: true,
  routingNotes: 'Use Codex for tests.',
};

const IDLE: WorkerSessionState = {
  lifecycle: 'ready',
  suspended: false,
  isGenerating: false,
  queuedPromptIds: [],
};
const BUSY: WorkerSessionState = { ...IDLE, lifecycle: 'working', isGenerating: true };

type Prompt = { conversationId: string; promptId: string; text: string; hiddenContext?: string };
type ModelOption = { id: string; name: string; description?: string };

/** Varsayılan sahte oturum, ayarlardaki kataloğun tamamını aynı kimliklerle sunar. */
function catalogOf(providerId: string): ModelOption[] {
  const worker = settings.workers.find((candidate) => candidate.providerId === providerId);
  return worker?.models.map(({ id, name }) => ({ id, name })) ?? [];
}

function createFakes() {
  const created: CreateConversationParams[] = [];
  const prompts: Prompt[] = [];
  const permissions: Array<{
    conversationId: string;
    requestId: string;
    options: Array<{ optionId: string; kind: string }>;
  }> = [];
  const resolved: Array<{ conversationId: string; requestId: string; optionId: string }> = [];
  const efforts: Array<{ conversationId: string; effort: string }> = [];
  const deleted: string[] = [];
  const cancelled: string[] = [];
  const terminated: string[] = [];
  const removedQueued: Array<{ conversationId: string; id: string }> = [];
  const sessions = new Map<string, WorkerSessionState>();
  /** Sağlayıcı oturumunun sunduğu modeller; tanımsızsa ayarlardaki katalog, null ise hiçbiri. */
  const providerModels = new Map<string, ModelOption[] | null>();
  /** İstenen model sunulmadığında oturumun açıldığı sağlayıcı varsayılanı. */
  const providerDefaults = new Map<string, string>();
  /** setModel ile oturumda seçilen modeller. */
  const modelChanges: Array<{ conversationId: string; model: string }> = [];
  const switchedModels = new Map<string, string>();
  /** Sağlayıcı iptale ve model değişikliğine uyuyor mu. */
  const behavior = { cancelStops: true, modelSwitches: true };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const deps: Omit<OrchestraServiceDeps, 'dataDirectory'> = {
    electronExecutable: process.execPath,
    logger: logger as never,
    createConversation: async (params: CreateConversationParams) => {
      created.push(params);
      return { id: params.id, providerId: params.provider } as never;
    },
    deleteConversation: async (input) => {
      deleted.push(input.conversationId);
    },
    attach: async () => ok(undefined),
    sendPrompt: async (input) => {
      prompts.push({
        conversationId: input.conversationId,
        promptId: input.promptId,
        ...input.prompt,
      });
      return ok({ queued: false });
    },
    cancelTurn: async (conversationId) => {
      cancelled.push(conversationId);
      const session = sessions.get(conversationId);
      if (session && behavior.cancelStops) {
        sessions.set(conversationId, { ...session, lifecycle: 'ready', isGenerating: false });
      }
      return ok(undefined);
    },
    deleteQueuedPrompt: async (input) => {
      removedQueued.push(input);
      const session = sessions.get(input.conversationId);
      if (session) {
        sessions.set(input.conversationId, {
          ...session,
          queuedPromptIds: session.queuedPromptIds.filter((id) => id !== input.id),
        });
      }
      return ok(undefined);
    },
    terminate: async (conversationId) => {
      terminated.push(conversationId);
      sessions.set(conversationId, { ...IDLE, lifecycle: 'closed' });
      return ok(undefined);
    },
    // Her istem gönderildiği anda tamamlanmış bir tur olarak geçmişte görünür.
    loadHistory: async (conversationId) =>
      ok({
        turns: prompts
          .filter((prompt) => prompt.conversationId === conversationId)
          .map((prompt, index) => ({
            outcome: { kind: 'done' },
            items: [
              { kind: 'message', role: 'user', promptId: prompt.promptId, text: prompt.text },
              { kind: 'message', role: 'assistant', text: `REPORT ${index + 1}: ${prompt.text}` },
            ],
          })),
      }),
    sessionState: async (conversationId) => sessions.get(conversationId) ?? IDLE,
    // Oturum, konuşmanın modelini yalnızca sunduğu kimliklerden biriyse uygular; değilse
    // sağlayıcı varsayılanıyla açılır (materyalizasyondaki sessiz düşüş gibi).
    sessionModel: async (conversationId) => {
      const params = created.find((candidate) => candidate.id === conversationId);
      const provider = String(params?.provider ?? '');
      const wanted = switchedModels.get(conversationId) ?? params?.model ?? null;
      const configured = providerModels.get(provider);
      if (configured === null) return null;
      const available = configured ?? catalogOf(provider);
      if (available.length === 0) return null;
      const selected =
        wanted && available.some((model) => model.id === wanted)
          ? wanted
          : (providerDefaults.get(provider) ?? null);
      return { selected, available };
    },
    setModel: async (conversationId, model) => {
      modelChanges.push({ conversationId, model });
      if (!behavior.modelSwitches) return false;
      switchedModels.set(conversationId, model);
      return true;
    },
    setEffort: async (conversationId, effort) => {
      efforts.push({ conversationId, effort });
      return effort === 'max' ? 'Extra high' : effort === 'high' ? 'High' : 'Medium';
    },
    pendingPermissions: async (conversationId) =>
      permissions.filter((request) => request.conversationId === conversationId),
    resolvePermission: async (input) => {
      resolved.push(input);
      permissions.splice(
        permissions.findIndex((request) => request.requestId === input.requestId),
        1
      );
      return ok(undefined);
    },
    timing: { cancelGraceMs: 50, lostGraceMs: 0 },
  };
  return {
    created,
    prompts,
    permissions,
    resolved,
    efforts,
    deleted,
    cancelled,
    terminated,
    removedQueued,
    sessions,
    providerModels,
    providerDefaults,
    modelChanges,
    behavior,
    deps,
  };
}

class BridgeClient {
  private buffer = '';
  private nextId = 1;
  private readonly waiters = new Map<number, (message: Record<string, unknown>) => void>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(this.buffer.slice(0, index)) as Record<string, unknown>;
        this.buffer = this.buffer.slice(index + 1);
        this.waiters.get(message.id as number)?.(message);
      }
    });
  }

  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async callTool(name: string, args: Record<string, unknown> = {}) {
    const response = await this.request('tools/call', { name, arguments: args });
    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    return { isError: result.isError, text: result.content[0]!.text };
  }

  /** Başarılı araç çağrısının JSON sonucunu döndürür; hata dönerse testi düşürür. */
  async callJson(name: string, args: Record<string, unknown> = {}) {
    const result = await this.callTool(name, args);
    expect(result.isError, result.text).toBe(false);
    return JSON.parse(result.text);
  }
}

describe('OrchestraService', () => {
  let directory: string;
  let service: OrchestraService;
  let fakes: ReturnType<typeof createFakes>;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orkestra-orchestra-'));
    fakes = createFakes();
    service = new OrchestraService({ ...fakes.deps, dataDirectory: directory });
  });

  afterEach(async () => {
    child?.kill();
    child = null;
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  async function startBridge(): Promise<BridgeClient> {
    const servers = await service.conductorMcpServers('conductor-1');
    expect(servers).toHaveLength(1);
    const server = servers![0]!;
    child = spawn(server.command, server.args, { env: { ...process.env, ...server.env } });
    return new BridgeClient(child);
  }

  function register(overrides: Partial<OrchestraSettings> = {}) {
    return service.register({
      conversationId: 'conductor-1',
      projectId: 'project-1',
      taskId: 'task-1',
      settings: { ...settings, ...overrides },
    });
  }

  /** Servis bağımlılıkları kurulurken kopyalar; değiştirilen sahteler için servisi yeniden kurar. */
  async function rebuild(overrides: Partial<OrchestraServiceDeps> = {}): Promise<void> {
    await service.dispose();
    Object.assign(fakes.deps, overrides);
    service = new OrchestraService({ ...fakes.deps, dataDirectory: directory });
  }

  /** Uygulamanın yeniden açılması: kayıtlar diskten okunur, bellekteki her şey sıfırlanır. */
  async function restart(overrides: Partial<OrchestraServiceDeps> = {}): Promise<BridgeClient> {
    child?.kill();
    child = null;
    await rebuild(overrides);
    return startBridge();
  }

  const spawnArgs = {
    agent: 'codex',
    model: 'gpt-6.1-sol',
    difficulty: 'hard',
    title: 'Write tests',
    reason: 'r',
    description: 'd',
    task: 'Add unit tests for the parser.',
  };

  it('returns no MCP servers for conversations that are not conductors', async () => {
    expect(await service.conductorMcpServers('plain')).toBeNull();
    expect(await service.conductorContext('plain')).toBeNull();
  });

  it('serves the conductor tools over the MCP bridge and runs workers end to end', async () => {
    await service.register({
      conversationId: 'conductor-1',
      projectId: 'project-1',
      taskId: 'task-1',
      settings,
    });
    const bridge = await startBridge();

    const init = await bridge.request('initialize', { protocolVersion: '2025-06-18' });
    const initResult = init.result as { instructions: string; protocolVersion: string };
    expect(initResult.protocolVersion).toBe('2025-06-18');
    expect(initResult.instructions).toContain('Orkestra conductor');
    expect(initResult.instructions).toContain('Use Codex for tests.');

    const list = await bridge.request('tools/list');
    const tools = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(tools).toEqual([
      'list_agents',
      'spawn_agent',
      'message_agent',
      'wait_for_agents',
      'get_agent_result',
      'list_workers',
      'cancel_agent',
    ]);

    const spawned = await bridge.callTool('spawn_agent', {
      agent: 'codex',
      model: 'gpt-6.1-sol',
      difficulty: 'hard',
      title: 'Write tests',
      role: 'test author',
      reason: 'Codex test yazımında güçlü.',
      description: 'Codex · GPT-6.1 Sol · zor — parser testleri',
      task: 'Add unit tests for the parser.',
    });
    expect(spawned.isError).toBe(false);
    const workerId = (JSON.parse(spawned.text) as { worker_id: string }).worker_id;
    expect(JSON.parse(spawned.text)).toMatchObject({
      model_name: 'GPT-6.1 Sol',
      model_auto_selected: false,
      difficulty: 'hard',
      effort: 'High',
      reason: 'Codex test yazımında güçlü.',
    });
    expect(fakes.created[0]?.title).toBe('🎼 Codex · GPT-6.1 Sol · Write tests');
    expect(fakes.efforts).toEqual([{ conversationId: expect.any(String), effort: 'high' }]);
    expect(fakes.created).toEqual([
      expect.objectContaining({
        id: workerId,
        projectId: 'project-1',
        taskId: 'task-1',
        provider: 'codex',
        model: 'gpt-6.1-sol',
        autoApprove: true,
        type: 'acp',
      }),
    ]);
    expect(fakes.prompts[0]).toMatchObject({
      conversationId: workerId,
      text: 'Add unit tests for the parser.',
    });
    expect(fakes.prompts[0]!.hiddenContext).toContain('worker agent in an Orkestra');

    const waited = JSON.parse(
      (await bridge.callTool('wait_for_agents', { timeout_seconds: 5 })).text
    );
    expect(waited.complete).toBe(true);
    expect(waited.workers[0]).toMatchObject({
      worker_id: workerId,
      status: 'done',
      report: 'REPORT 1: Add unit tests for the parser.',
    });

    await bridge.callTool('message_agent', { worker_id: workerId, message: 'Also cover errors.' });
    const result = JSON.parse(
      (await bridge.callTool('get_agent_result', { worker_id: workerId })).text
    );
    expect(result.report).toBe('REPORT 2: Also cover errors.');

    const agents = JSON.parse((await bridge.callTool('list_agents')).text);
    const codex = agents.agents.find((agent: { agent: string }) => agent.agent === 'codex');
    expect(codex.observed).toMatchObject({ tasks: 2, success_rate: 1 });
    expect(agents.max_parallel).toBe('unlimited');

    const session = await service.get('conductor-1');
    expect(session?.workers.map((worker) => worker.workerId)).toEqual([workerId]);
  });

  it('rejects agents and models outside the orchestra', async () => {
    await service.register({
      conversationId: 'conductor-1',
      projectId: 'project-1',
      taskId: 'task-1',
      settings,
    });
    const bridge = await startBridge();
    const unknownAgent = await bridge.callTool('spawn_agent', { agent: 'grok', task: 'x' });
    expect(unknownAgent.isError).toBe(true);
    expect(unknownAgent.text).toContain('codex, claude');
    const unknownModel = await bridge.callTool('spawn_agent', {
      agent: 'codex',
      model: 'nope',
      task: 'x',
    });
    expect(unknownModel.isError).toBe(true);
    const base = { agent: 'codex', task: 'x', title: 't', reason: 'r', description: 'd' };
    const astra = await bridge.callTool('spawn_agent', {
      ...base,
      model: 'gpt-6-astra',
      difficulty: 'critical',
    });
    expect(astra.isError).toBe(true);
    expect(astra.text).toContain('işçi modeli olarak kullanılmaz');
    expect(astra.text).toContain('gpt-6.1-sol');
    const tooWeak = await bridge.callTool('spawn_agent', {
      ...base,
      model: 'gpt-6-luna',
      difficulty: 'critical',
    });
    expect(tooWeak.isError).toBe(true);
    expect(tooWeak.text).toContain('yetersiz');
    const noDifficulty = await bridge.callTool('spawn_agent', base);
    expect(noDifficulty.isError).toBe(true);
    expect(fakes.created).toHaveLength(0);
    const auto = JSON.parse(
      (await bridge.callTool('spawn_agent', { ...base, difficulty: 'trivial' })).text
    );
    expect(auto).toMatchObject({ model: 'gpt-6-luna', model_auto_selected: true });
  });

  it('rejects RPC requests without the conductor token', async () => {
    await service.register({
      conversationId: 'conductor-1',
      projectId: 'project-1',
      taskId: 'task-1',
      settings,
    });
    const [server] = (await service.conductorMcpServers('conductor-1'))!;
    const response = await fetch(server!.env!.ORKESTRA_ORCHESTRA_URL!, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'describe' }),
    });
    expect(response.status).toBe(403);
  });

  it('auto-approves pending worker permissions only when enabled', async () => {
    // Tamamlanmamış tur: geçmiş boş, oturum çalışıyor; işçi çalışıyor ya da izin bekliyor görünür.
    fakes.deps.loadHistory = async () => ok({ turns: [] });
    fakes.deps.sessionState = async () => BUSY;
    await service.dispose();
    service = new OrchestraService({ ...fakes.deps, dataDirectory: directory });
    const register = (autoApproveWorkers: boolean) =>
      service.register({
        conversationId: 'conductor-1',
        projectId: 'project-1',
        taskId: 'task-1',
        settings: { ...settings, autoApproveWorkers },
      });
    await register(false);
    const bridge = await startBridge();
    const spawned = JSON.parse(
      (
        await bridge.callTool('spawn_agent', {
          agent: 'codex',
          model: 'gpt-6.1-sol',
          difficulty: 'standard',
          title: 'Edit',
          reason: 'r',
          description: 'd',
          task: 'Edit files.',
        })
      ).text
    );
    fakes.permissions.push({
      conversationId: spawned.worker_id,
      requestId: 'r1',
      options: [
        { optionId: 'deny', kind: 'reject_once' },
        { optionId: 'yes', kind: 'allow_once' },
      ],
    });
    const blocked = JSON.parse(
      (await bridge.callTool('get_agent_result', { worker_id: spawned.worker_id })).text
    );
    expect(blocked.status).toBe('awaiting-permission');
    expect(fakes.resolved).toEqual([]);

    await register(true);
    const approved = JSON.parse(
      (await bridge.callTool('get_agent_result', { worker_id: spawned.worker_id })).text
    );
    expect(approved.status).toBe('running');
    expect(fakes.resolved).toEqual([
      { conversationId: spawned.worker_id, requestId: 'r1', optionId: 'yes' },
    ]);
  });

  it('persists sessions across service instances', async () => {
    await service.register({
      conversationId: 'conductor-1',
      projectId: 'project-1',
      taskId: 'task-1',
      settings,
    });
    await service.dispose();
    const reloaded = new OrchestraService({ ...fakes.deps, dataDirectory: directory });
    expect((await reloaded.get('conductor-1'))?.settings.routingNotes).toBe('Use Codex for tests.');
    await reloaded.dispose();
  });

  describe('worker state after the session is re-opened', () => {
    beforeEach(async () => {
      // Tur sürerken uygulama kapanır: geçmişte tamamlanmış tur yok, oturum çalışıyor.
      await rebuild({
        loadHistory: async () => ok({ turns: [] }),
        sessionState: async () => BUSY,
      });
    });

    it('settles from replayed history without prompt ids and keeps the report afterwards', async () => {
      await register();
      let bridge = await startBridge();
      const { worker_id: workerId } = await bridge.callJson('spawn_agent', spawnArgs);
      expect((await bridge.callJson('get_agent_result', { worker_id: workerId })).status).toBe(
        'running'
      );

      // Yeniden açılışta çalışma zamanı işçiyi tanımaz ("not attached"); bağlanınca oturum, istem
      // kimliği ve tur sonucu olmadan yeniden oynatılır.
      let attached = false;
      const replay = vi.fn(async () =>
        attached
          ? ok({
              turns: [
                {
                  items: [
                    {
                      kind: 'message',
                      role: 'user',
                      text: `Add unit tests for the parser.\nYou are a worker agent in an Orkestra team.`,
                    },
                    { kind: 'execute-tool-call', text: undefined },
                    { kind: 'message', role: 'assistant', text: '## Summary\nTestler eklendi.' },
                  ],
                },
              ],
            })
          : err({
              type: 'invalid_state',
              message: `ACP conversation '${workerId}' is not attached`,
            })
      );
      bridge = await restart({
        loadHistory: replay,
        attach: async () => {
          attached = true;
          return ok(undefined);
        },
        sessionState: async () => IDLE,
      });
      const waited = await bridge.callJson('wait_for_agents', { timeout_seconds: 5 });
      expect(waited.complete).toBe(true);
      expect(waited.workers[0]).toMatchObject({
        worker_id: workerId,
        status: 'done',
        report: '## Summary\nTestler eklendi.',
      });
      expect(attached).toBe(true);

      // Kesinleşen sonuç kayıttan okunur: oturum yeniden kapansa da geçmiş yeniden yüklenmez.
      const unreachable = vi.fn(async () => err({ type: 'invalid_state', message: 'gone' }));
      bridge = await restart({ loadHistory: unreachable, attach: unreachable });
      const result = await bridge.callJson('get_agent_result', { worker_id: workerId });
      expect(result).toMatchObject({ status: 'done', report: '## Summary\nTestler eklendi.' });
      expect((await bridge.callJson('wait_for_agents', { timeout_seconds: 5 })).complete).toBe(
        true
      );
      expect(unreachable).not.toHaveBeenCalled();
    });

    it('treats a replayed turn that stopped mid-tool as lost with its partial output', async () => {
      await register();
      let bridge = await startBridge();
      const { worker_id: workerId } = await bridge.callJson('spawn_agent', spawnArgs);
      bridge = await restart({
        loadHistory: async () =>
          ok({
            turns: [
              {
                items: [
                  { kind: 'message', role: 'user', text: 'Add unit tests for the parser.' },
                  { kind: 'message', role: 'assistant', text: 'Testleri çalıştırıyorum.' },
                  { kind: 'execute-tool-call' },
                ],
              },
            ],
          }),
        sessionState: async () => IDLE,
      });
      const result = await bridge.callJson('get_agent_result', { worker_id: workerId });
      expect(result).toMatchObject({ status: 'lost', report: 'Testleri çalıştırıyorum.' });
      expect(result.error).toContain('yarıda kesilmiş');
    });

    it('marks unreachable workers lost so waits end and parallel slots free up', async () => {
      await register({ maxParallel: 1 });
      let bridge = await startBridge();
      const { worker_id: oldId } = await bridge.callJson('spawn_agent', spawnArgs);
      const full = await bridge.callTool('spawn_agent', spawnArgs);
      expect(full.isError).toBe(true);
      expect(full.text).toContain('Paralel sınırına ulaşıldı');

      const notAttached = err({
        type: 'invalid_state',
        message: 'ACP conversation is not attached',
      });
      bridge = await restart({
        loadHistory: async (conversationId) =>
          conversationId === oldId ? notAttached : ok({ turns: [] }),
        attach: async (conversationId) =>
          conversationId === oldId
            ? err({ type: 'spawn_failed', cause: { message: 'codex: command not found' } })
            : ok(undefined),
      });
      const waited = await bridge.callJson('wait_for_agents', { timeout_seconds: 5 });
      expect(waited.complete).toBe(true);
      expect(waited.workers[0]).toMatchObject({ worker_id: oldId, status: 'lost' });
      expect(waited.workers[0].error).toContain('ulaşılamadı');
      expect(waited.workers[0].error).toContain('codex: command not found');

      const next = await bridge.callJson('spawn_agent', spawnArgs);
      expect(next.status).toBe('running');
    });

    it('waits out transient failures but marks a deleted worker lost at once', async () => {
      await register();
      let bridge = await startBridge();
      const { worker_id: deletedId } = await bridge.callJson('spawn_agent', spawnArgs);
      const { worker_id: flakyId } = await bridge.callJson('spawn_agent', {
        ...spawnArgs,
        task: 'Fix the flaky test.',
      });
      const missing = async (conversationId: string) => {
        if (conversationId === deletedId) {
          throw new Error(`Conversation '${conversationId}' was not found`);
        }
        return err({ type: 'host_unreachable', message: 'SSH bağlantısı yok' });
      };
      bridge = await restart({
        loadHistory: missing,
        attach: missing,
        timing: { lostGraceMs: 60_000 },
      });
      const gone = await bridge.callJson('get_agent_result', { worker_id: deletedId });
      expect(gone.status).toBe('lost');
      expect(gone.error).toContain('bulunamadı');
      const flaky = await bridge.callJson('get_agent_result', { worker_id: flakyId });
      expect(flaky.status).toBe('running');
      const waited = await bridge.callJson('wait_for_agents', {
        worker_ids: [deletedId],
        timeout_seconds: 5,
      });
      expect(waited).toMatchObject({ complete: true, workers: [{ status: 'lost' }] });
    });
  });

  describe('cancel_agent', () => {
    beforeEach(async () => {
      await rebuild({ loadHistory: async () => ok({ turns: [] }) });
    });

    it('drops queued prompts, stops the turn and settles the worker', async () => {
      await register();
      const bridge = await startBridge();
      const { worker_id: workerId } = await bridge.callJson('spawn_agent', spawnArgs);
      fakes.sessions.set(workerId, { ...BUSY, queuedPromptIds: ['queued-1'] });

      const cancelled = await bridge.callJson('cancel_agent', { worker_id: workerId });
      expect(cancelled).toMatchObject({
        worker_id: workerId,
        cancelled: true,
        status: 'cancelled',
      });
      expect(fakes.removedQueued).toEqual([{ conversationId: workerId, id: 'queued-1' }]);
      expect(fakes.cancelled).toEqual([workerId]);
      expect(fakes.terminated).toEqual([]);

      const waited = await bridge.callJson('wait_for_agents', { timeout_seconds: 5 });
      expect(waited).toMatchObject({ complete: true, workers: [{ status: 'cancelled' }] });
      const again = await bridge.callJson('cancel_agent', { worker_id: workerId });
      expect(again).toMatchObject({ cancelled: false, status: 'cancelled' });
    });

    it('terminates a worker session that ignores cancellation', async () => {
      await register();
      const bridge = await startBridge();
      const { worker_id: workerId } = await bridge.callJson('spawn_agent', spawnArgs);
      fakes.sessions.set(workerId, BUSY);
      fakes.behavior.cancelStops = false;

      const cancelled = await bridge.callJson('cancel_agent', { worker_id: workerId });
      expect(cancelled).toMatchObject({ cancelled: true, status: 'cancelled' });
      expect(cancelled.note).toContain('sonlandırıldı');
      expect(fakes.terminated).toEqual([workerId]);
      expect((await bridge.callJson('get_agent_result', { worker_id: workerId })).status).toBe(
        'cancelled'
      );
    });
  });

  describe('effective worker model', () => {
    const codexCatalog = {
      providerId: 'codex',
      name: 'Codex',
      models: [
        { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', intelligence: 5, speed: 4 },
        { id: 'gpt-6-astra', name: 'GPT-6 Astra', intelligence: 5, speed: 3 },
        { id: 'gpt-6-pro', name: 'GPT-6 Pro', intelligence: 5, speed: 2 },
        { id: 'gpt-6-luna', name: 'GPT-6 Luna', intelligence: 4, speed: 5 },
      ],
    };

    it('removes a worker whose session runs another model and lists usable models', async () => {
      // Eski uzak CLI GPT-6.1 Sol'u listelemiyor; oturum sağlayıcı varsayılanı Astra ile açılır.
      fakes.providerModels.set('codex', [
        { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
        { id: 'gpt-6-pro', name: 'GPT-6 Pro' },
        { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
      ]);
      fakes.providerDefaults.set('codex', 'gpt-6-astra');
      await register({ workers: [codexCatalog] });
      const bridge = await startBridge();

      const rejected = await bridge.callTool('spawn_agent', spawnArgs);
      expect(rejected.isError).toBe(true);
      expect(rejected.text).toContain('GPT-6.1 Sol modelini sunmuyor');
      expect(rejected.text).toContain('GPT-6 Astra ile açıldı');
      expect(rejected.text).toContain('gpt-6-pro (GPT-6 Pro)');
      expect(rejected.text).not.toContain('gpt-6-luna');
      expect(fakes.deleted).toEqual([fakes.created[0]!.id]);
      expect(fakes.prompts).toEqual([]);
      expect((await service.get('conductor-1'))?.workers).toEqual([]);

      const agents = await bridge.callJson('list_agents');
      const codex = agents.agents.find((agent: { agent: string }) => agent.agent === 'codex');
      expect(codex.models.map((model: { id: string }) => model.id)).toEqual([
        'gpt-6-pro',
        'gpt-6-luna',
      ]);
      expect(codex.not_offered_by_session).toEqual(['gpt-6.1-sol']);

      const retried = await bridge.callJson('spawn_agent', { ...spawnArgs, model: undefined });
      expect(retried).toMatchObject({ model: 'gpt-6-pro', model_auto_selected: true });
      expect(fakes.deleted).toHaveLength(1);
    });

    // Claude oturumu modelleri kendi takma adlarıyla sunar ("opus[1m]", "sonnet").
    const claudeLive = [
      {
        id: 'default',
        name: 'Default (recommended)',
        description: 'Use the default model (currently Opus 5.5)',
      },
      { id: 'opus[1m]', name: 'Opus', description: 'Opus 5.5 with 1M context' },
      { id: 'sonnet', name: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
    ];
    const claudeCatalog = {
      providerId: 'claude',
      name: 'Claude Code',
      models: [
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
      ],
    };
    const claudeArgs = { ...spawnArgs, agent: 'claude', model: 'claude-opus-5-5' };

    it("applies a catalog model through the provider's own option id", async () => {
      fakes.providerModels.set('claude', claudeLive);
      fakes.providerDefaults.set('claude', 'default');
      await register({ workers: [claudeCatalog] });
      const bridge = await startBridge();

      const first = await bridge.callJson('spawn_agent', claudeArgs);
      expect(first).toMatchObject({ model: 'claude-opus-5-5', model_name: 'Claude Opus 5.5' });
      expect(fakes.created[0]?.model).toBe('claude-opus-5-5');
      expect(fakes.modelChanges).toEqual([{ conversationId: first.worker_id, model: 'opus[1m]' }]);

      // Oturumun sunduğu modeller artık biliniyor: kimlik doğrudan kaydedilir, eşleşmeyenler
      // (Sonnet 5.5 yerine Sonnet 5, Haiku yok) şefe sunulmaz.
      const second = await bridge.callJson('spawn_agent', claudeArgs);
      expect(fakes.created[1]?.model).toBe('opus[1m]');
      expect(fakes.modelChanges).toHaveLength(1);
      expect(second.model).toBe('claude-opus-5-5');
      const agents = await bridge.callJson('list_agents');
      expect(agents.agents[0].models.map((model: { id: string }) => model.id)).toEqual([
        'claude-opus-5-5',
      ]);
      expect(agents.agents[0].not_offered_by_session).toEqual([
        'claude-sonnet-5-5',
        'claude-haiku-4-5',
      ]);
      const sonnet = await bridge.callTool('spawn_agent', {
        ...claudeArgs,
        model: 'claude-sonnet-5-5',
        difficulty: 'standard',
      });
      expect(sonnet.isError).toBe(true);
      expect(sonnet.text).toContain('oturumunda sunulmuyor');
      expect(fakes.deleted).toEqual([]);
    });

    it('removes a worker whose provider does not switch to the requested model', async () => {
      fakes.providerModels.set('claude', claudeLive);
      fakes.providerDefaults.set('claude', 'default');
      fakes.behavior.modelSwitches = false;
      await register({ workers: [claudeCatalog] });
      const bridge = await startBridge();
      const rejected = await bridge.callTool('spawn_agent', claudeArgs);
      expect(rejected.isError).toBe(true);
      expect(rejected.text).toContain('Claude Opus 5.5 istendi ama Claude Code oturumu bu modele');
      expect(rejected.text).toContain('Default (recommended) ile çalışıyor');
      expect(fakes.deleted).toEqual([fakes.created[0]!.id]);
      expect(fakes.prompts).toEqual([]);
    });

    it('rejects every Astra variant, also as the default of an agent without a model list', async () => {
      fakes.providerModels.set('opencode', [{ id: 'gpt-6.1-astra', name: 'GPT-6.1 Astra' }]);
      fakes.providerDefaults.set('opencode', 'gpt-6.1-astra');
      await register({
        workers: [
          {
            providerId: 'codex',
            name: 'Codex',
            models: [
              { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', intelligence: 5 },
              { id: 'gpt-6.1-astra', name: 'GPT-6.1 Astra', intelligence: 5 },
            ],
          },
          { providerId: 'opencode', name: 'OpenCode', models: [] },
        ],
      });
      const bridge = await startBridge();
      const requested = await bridge.callTool('spawn_agent', {
        ...spawnArgs,
        model: 'gpt-6.1-astra',
        difficulty: 'critical',
      });
      expect(requested.isError).toBe(true);
      expect(requested.text).toContain('işçi modeli olarak kullanılmaz');
      expect(fakes.created).toHaveLength(0);

      const defaulted = await bridge.callTool('spawn_agent', {
        ...spawnArgs,
        agent: 'opencode',
        model: undefined,
        difficulty: 'standard',
      });
      expect(defaulted.isError).toBe(true);
      expect(defaulted.text).toContain('GPT-6.1 Astra ile açıldı');
      expect(defaulted.text).toContain('hiçbir zaman kullanılmaz');
      expect(fakes.deleted).toEqual([fakes.created[0]!.id]);
    });

    it('reserves Claude Fable for critical work by model family', async () => {
      fakes.providerModels.set('claude', [
        ...claudeLive,
        { id: 'claude-fable-5-1[1m]', name: 'Fable', description: 'Fable 5.1 · Most capable' },
      ]);
      fakes.providerDefaults.set('claude', 'default');
      // Model listesi olmayan ajanın varsayılanı, açıklamasında yazan Fable sürümüne çözülür.
      fakes.providerModels.set('claude-default', [
        {
          id: 'default',
          name: 'Default (recommended)',
          description: 'Use the default model (currently Fable 5.2 (1M context))',
        },
      ]);
      fakes.providerDefaults.set('claude-default', 'default');
      await register({
        workers: [
          {
            providerId: 'claude',
            name: 'Claude Code',
            models: [
              { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
              { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
              { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
            ],
          },
          { providerId: 'claude-default', name: 'Claude Default', models: [] },
        ],
      });
      const bridge = await startBridge();
      const fable = { ...spawnArgs, agent: 'claude', model: 'claude-fable-5-1' };
      const hard = await bridge.callTool('spawn_agent', fable);
      expect(hard.isError).toBe(true);
      expect(hard.text).toContain('yalnızca kritik');
      expect(hard.text).toContain('claude-opus-5-5');
      expect(fakes.created).toHaveLength(0);

      const critical = await bridge.callJson('spawn_agent', { ...fable, difficulty: 'critical' });
      expect(critical).toMatchObject({ model: 'claude-fable-5-1', difficulty: 'critical' });
      expect(fakes.modelChanges).toEqual([
        { conversationId: critical.worker_id, model: 'claude-fable-5-1[1m]' },
      ]);

      const defaulted = await bridge.callTool('spawn_agent', {
        ...spawnArgs,
        agent: 'claude-default',
        model: undefined,
        difficulty: 'standard',
      });
      expect(defaulted.isError).toBe(true);
      expect(defaulted.text).toContain('currently Fable 5.2 (1M context)) ile açıldı');
      expect(defaulted.text).toContain('yalnızca kritik');
      expect(fakes.deleted).toHaveLength(1);
    });
  });
});
