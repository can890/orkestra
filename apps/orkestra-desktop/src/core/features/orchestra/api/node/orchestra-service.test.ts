import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '@orkestra/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestraSettings } from '@core/features/orchestra/api/orchestra';
import type { CreateConversationParams } from '@core/primitives/conversations/api';
import { OrchestraService } from './orchestra-service';

const settings: OrchestraSettings = {
  conductorProviderId: 'claude',
  conductorModel: null,
  workers: [
    { providerId: 'codex', name: 'Codex', models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra' }] },
    { providerId: 'claude', name: 'Claude Code', models: [] },
  ],
  maxParallel: 0,
  autoApproveWorkers: true,
  routingNotes: 'Use Codex for tests.',
};

type Prompt = { conversationId: string; promptId: string; text: string; hiddenContext?: string };

function createFakes() {
  const created: CreateConversationParams[] = [];
  const prompts: Prompt[] = [];
  const permissions: Array<{
    conversationId: string;
    requestId: string;
    options: Array<{ optionId: string; kind: string }>;
  }> = [];
  const resolved: Array<{ conversationId: string; requestId: string; optionId: string }> = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    created,
    prompts,
    permissions,
    resolved,
    deps: {
      electronExecutable: process.execPath,
      logger: logger as never,
      createConversation: async (params: CreateConversationParams) => {
        created.push(params);
        return { id: params.id, providerId: params.provider } as never;
      },
      attach: async () => ok(undefined),
      sendPrompt: async (input: {
        conversationId: string;
        promptId: string;
        prompt: { text: string; hiddenContext?: string };
      }) => {
        prompts.push({
          conversationId: input.conversationId,
          promptId: input.promptId,
          ...input.prompt,
        });
        return ok({ queued: false });
      },
      cancelTurn: async () => ok(undefined),
      // Her istem gönderildiği anda tamamlanmış bir tur olarak geçmişte görünür.
      loadHistory: async (conversationId: string) =>
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
      pendingPermissions: async (conversationId: string) =>
        permissions.filter((request) => request.conversationId === conversationId),
      resolvePermission: async (input: {
        conversationId: string;
        requestId: string;
        optionId: string;
      }) => {
        resolved.push(input);
        permissions.splice(
          permissions.findIndex((request) => request.requestId === input.requestId),
          1
        );
        return ok(undefined);
      },
    },
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
      model: 'gpt-6-astra',
      title: 'Write tests',
      role: 'test author',
      reason: 'Codex test yazımında güçlü.',
      description: 'Codex · GPT-6 Astra — parser testleri',
      task: 'Add unit tests for the parser.',
    });
    expect(spawned.isError).toBe(false);
    const workerId = (JSON.parse(spawned.text) as { worker_id: string }).worker_id;
    expect(JSON.parse(spawned.text)).toMatchObject({
      model_name: 'GPT-6 Astra',
      reason: 'Codex test yazımında güçlü.',
    });
    expect(fakes.created[0]?.title).toBe('🎼 Codex · GPT-6 Astra · Write tests');
    expect(fakes.created).toEqual([
      expect.objectContaining({
        id: workerId,
        projectId: 'project-1',
        taskId: 'task-1',
        provider: 'codex',
        model: 'gpt-6-astra',
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
    const missingModel = await bridge.callTool('spawn_agent', {
      agent: 'codex',
      task: 'x',
      title: 't',
      reason: 'r',
      description: 'd',
    });
    expect(missingModel.isError).toBe(true);
    expect(missingModel.text).toContain('gpt-6-astra (GPT-6 Astra)');
    expect(fakes.created).toHaveLength(0);
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
    // Tamamlanmamış tur: geçmiş boş kalır, işçi çalışıyor ya da izin bekliyor görünür.
    fakes.deps.loadHistory = async () => ok({ turns: [] });
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
          model: 'gpt-6-astra',
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
});
