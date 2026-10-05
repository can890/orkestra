import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatHostRef,
  hostRef,
  LOCAL_HOST_REF,
  type HostRef,
} from '@orkestra/core/primitives/host/api';
import { err, ok } from '@orkestra/shared';
import { createScope } from '@orkestra/shared/concurrency';
import type { LiveSource } from '@orkestra/wire/rpc';
import {
  encodeTopic,
  isDownloadFileOpenResult,
  WireError,
  type WireFile,
} from '@orkestra/wire/rpc';
import { describe, expect, it, vi } from 'vitest';
import type { OrchestraSettings } from '@core/features/orchestra/api/orchestra';
import type {
  AgentToolsMcpServer,
  ConversationMcpServerProvider,
  ConversationToolContext,
} from '@core/services/agent-tools/api/agent-tools';
import type {
  AgentToolsBridgeHost,
  AgentToolsBridgeServerInput,
} from '@core/services/agent-tools/node/agent-tools-host';
import { conversationsContract } from '../api';
import type { ConversationsRuntimeResolveError as RuntimeResolveError } from '../api/runtime-adapter';
import {
  createConversationsWireController,
  type CreateConversationsWireControllerOptions,
} from './wire-controller';

vi.mock('@core/features/conversations/node/controller', () => ({
  createConversationOperations: () => ({
    getConversations: vi.fn(),
    createConversation: vi.fn(),
    deleteConversation: vi.fn(),
    hydrateConversation: vi.fn(),
    dehydrateConversation: vi.fn(),
    renameConversation: vi.fn(),
    getConversationsForTask: vi.fn(),
    getConversationsForProject: vi.fn(),
    markConversationSeen: vi.fn(),
  }),
}));
const target = {
  conversationId: 'conversation-1',
  projectId: 'project-1',
  taskId: 'task-1',
  conversationType: 'acp',
  providerId: 'claude',
  sessionId: null,
  model: null,
  modeId: null,
  effort: null,
  collaborationMode: null,
  workspacePath: '/repo',
  host: LOCAL_HOST_REF,
  acpInput: {
    conversationId: 'conversation-1',
    providerId: 'claude',
    cwd: '/repo',
    sessionId: null,
    model: null,
    modeId: null,
    collaborationMode: null,
  },
} as const;
type TestRuntimeTarget = typeof target;

describe('createConversationsWireController', () => {
  it('adds project environment variables to trusted ACP spawn input', async () => {
    const attach = vi.fn(async () => ok(undefined));
    const getProviderEnv = vi.fn(async () => ({
      CLAUDE_CONFIG_DIR: '/provider/config',
      PROVIDER_ONLY: 'provider',
    }));
    const resolveLaunchContext = vi.fn(async () =>
      ok({
        workspace: {
          workspaceId: 'workspace-1',
          projectId: target.projectId,
          host: LOCAL_HOST_REF,
          path: target.workspacePath,
        },
        tmux: false,
        env: {
          CLAUDE_CONFIG_DIR: '/project/config',
          PROJECT_ONLY: 'project',
        },
      })
    );
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          leftJoin: () => ({
            where: () => ({
              limit: async () => [
                {
                  projectId: target.projectId,
                  taskId: target.taskId,
                  providerId: target.providerId,
                  sessionId: null,
                  config: null,
                  type: 'acp',
                  workspaceId: 'workspace-1',
                },
              ],
            }),
          }),
        }),
      })),
    };
    const controller = createConversationsWireController({
      terminalFileSources: { prepare: vi.fn() },
      db: db as never,
      logger: { warn: vi.fn() } as never,
      runtimes: { client: async () => ok({ acp: { attach } }) } as never,
      workspaceIdentity: {
        resolve: vi.fn(async () => ({ host: LOCAL_HOST_REF, path: target.workspacePath })),
      },
      getProviderEnv,
      sessionLaunchContexts: { resolve: resolveLaunchContext },
      telemetry: { capture: vi.fn() } as never,
      projects: { requireAttached: vi.fn(() => ok({} as never)) },
      taskSessions: { getTask: vi.fn() },
      withCompensation: async ({ action }) => action(),
      hostIsReachable: () => true,
    });

    await expect(
      controller.call('acp.attach', { conversationId: target.conversationId })
    ).resolves.toEqual(ok(undefined));

    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          CLAUDE_CONFIG_DIR: '/project/config',
          PROVIDER_ONLY: 'provider',
          PROJECT_ONLY: 'project',
        },
      }),
      {}
    );
    expect(resolveLaunchContext).toHaveBeenCalledWith({
      projectId: target.projectId,
      taskId: target.taskId,
      workspaceId: 'workspace-1',
    });
  });

  it('attaches with the trusted descriptor and activates while loading history', async () => {
    const attach = vi.fn(async () => ok(undefined));
    const loadHistory = vi.fn(async () => ok({ turns: [], nextCursor: null }));
    const controller = setupController({ client: { acp: { attach, loadHistory } } });

    await expect(
      controller.call('acp.attach', { conversationId: target.conversationId })
    ).resolves.toEqual(ok(undefined));
    await expect(
      controller.call('acp.loadHistory', { conversationId: target.conversationId, limit: 100 })
    ).resolves.toEqual(ok({ turns: [], nextCursor: null }));

    expect(attach).toHaveBeenCalledWith(target.acpInput, {});
    expect(loadHistory).toHaveBeenCalledWith(
      { conversationId: target.conversationId, limit: 100 },
      {}
    );
  });

  it('acknowledges config mutations only after host config persistence succeeds', async () => {
    const setOption = vi.fn(async () => ok(undefined));
    const persistAcpConfigOption = vi.fn(async () => {});
    const controller = setupController({
      client: { acp: { setOption } },
      hooks: { persistAcpConfigOption },
    });
    const input = {
      conversationId: target.conversationId,
      key: 'effort' as const,
      value: 'high',
    };

    await expect(controller.call('acp.setOption', input)).resolves.toEqual(ok(undefined));
    expect(persistAcpConfigOption).toHaveBeenCalledWith(target, 'effort', 'high');

    persistAcpConfigOption.mockRejectedValueOnce(new Error('host rejected write'));
    await expect(controller.call('acp.setOption', input)).resolves.toMatchObject({
      success: false,
      error: { type: 'set_config_failed', cause: { message: 'host rejected write' } },
    });
  });

  it('clears unsupported selections reported by activation from host config', async () => {
    const loadHistory = vi.fn(async () =>
      ok({
        turns: [],
        nextCursor: null,
        clearedConfiguration: ['model', 'modeId', 'collaborationMode'] as const,
      })
    );
    const persistAcpConfigOption = vi.fn(async () => {});
    const controller = setupController({
      client: { acp: { loadHistory } },
      hooks: { persistAcpConfigOption },
    });

    await controller.call('acp.loadHistory', {
      conversationId: target.conversationId,
      limit: 50,
    });

    expect(persistAcpConfigOption.mock.calls).toEqual([
      [target, 'model', null],
      [target, 'modeId', null],
      [target, 'collaborationMode', null],
    ]);
  });

  it('stores selections that activation applied under the provider option ids', async () => {
    const history = ok({
      turns: [],
      nextCursor: null,
      resolvedConfiguration: { model: 'sonnet', effort: 'high', collaborationMode: 'plan' },
    });
    const loadHistory = vi.fn(async () => history);
    const persistAcpConfigOption = vi.fn(async () => {});
    const controller = setupController({
      client: { acp: { loadHistory } },
      hooks: { persistAcpConfigOption },
    });

    await expect(
      controller.call('acp.loadHistory', { conversationId: target.conversationId, limit: 50 })
    ).resolves.toEqual(history);

    expect(persistAcpConfigOption.mock.calls).toEqual([
      [target, 'model', 'sonnet'],
      [target, 'effort', 'high'],
      [target, 'collaborationMode', 'plan'],
    ]);
  });

  it.each([
    ['is absent', {}],
    ['is empty', { resolvedConfiguration: {} }],
    ['holds only blank values', { resolvedConfiguration: { model: '', effort: '' } }],
  ])('stores nothing when the resolved configuration %s', async (_case, configuration) => {
    const loadHistory = vi.fn(async () => ok({ turns: [], nextCursor: null, ...configuration }));
    const persistAcpConfigOption = vi.fn(async () => {});
    const controller = setupController({
      client: { acp: { loadHistory } },
      hooks: { persistAcpConfigOption },
    });

    await controller.call('acp.loadHistory', { conversationId: target.conversationId, limit: 50 });

    expect(persistAcpConfigOption).not.toHaveBeenCalled();
  });

  it('stores nothing when loading history fails', async () => {
    const failure = err({
      type: 'initialize_failed' as const,
      cause: { name: 'Error', message: 'boom' },
    });
    const loadHistory = vi.fn(async () => failure);
    const persistAcpConfigOption = vi.fn(async () => {});
    const controller = setupController({
      client: { acp: { loadHistory } },
      hooks: { persistAcpConfigOption },
    });

    await expect(
      controller.call('acp.loadHistory', { conversationId: target.conversationId, limit: 50 })
    ).resolves.toEqual(failure);
    expect(persistAcpConfigOption).not.toHaveBeenCalled();
  });

  it('logs failed configuration writes without failing history or later writes', async () => {
    const history = ok({
      turns: [],
      nextCursor: null,
      clearedConfiguration: ['modeId' as const],
      resolvedConfiguration: { model: 'sonnet', effort: 'high' },
    });
    const loadHistory = vi.fn(async () => history);
    const persistAcpConfigOption = vi.fn(async (_target: TestRuntimeTarget, key: string) => {
      if (key !== 'effort') throw new Error('host rejected write');
    });
    const logger = { warn: vi.fn() };
    const controller = setupController({
      client: { acp: { loadHistory } },
      hooks: { persistAcpConfigOption },
      logger,
    });

    await expect(
      controller.call('acp.loadHistory', { conversationId: target.conversationId, limit: 50 })
    ).resolves.toEqual(history);

    expect(persistAcpConfigOption.mock.calls).toEqual([
      [target, 'modeId', null],
      [target, 'model', 'sonnet'],
      [target, 'effort', 'high'],
    ]);
    expect(logger.warn.mock.calls).toEqual([
      [
        'ACP runtime failed to clear unsupported stored configuration',
        {
          conversationId: target.conversationId,
          key: 'modeId',
          error: 'Error: host rejected write',
        },
      ],
      [
        'ACP runtime failed to store resolved configuration',
        {
          conversationId: target.conversationId,
          key: 'model',
          error: 'Error: host rejected write',
        },
      ],
    ]);
  });

  it('clears unsupported selections alongside storing resolved ones', async () => {
    const history = ok({
      turns: [],
      nextCursor: null,
      clearedConfiguration: ['modeId' as const, 'effort' as const],
      clearedValues: { modeId: 'removed-mode', effort: 'max' },
      resolvedConfiguration: { model: 'sonnet' },
    });
    const loadHistory = vi.fn(async () => history);
    const persistAcpConfigOption = vi.fn(async () => {});
    const controller = setupController({
      client: { acp: { loadHistory } },
      hooks: { persistAcpConfigOption },
    });

    // The renderer receives the activation report unchanged to tell the user what was dropped.
    await expect(
      controller.call('acp.loadHistory', { conversationId: target.conversationId, limit: 50 })
    ).resolves.toEqual(history);

    expect(persistAcpConfigOption.mock.calls).toEqual([
      [target, 'modeId', null],
      [target, 'effort', null],
      [target, 'model', 'sonnet'],
    ]);
  });

  it('allows activation to finish before acknowledging prompt acceptance', async () => {
    const sendPrompt = vi.fn(async () => ok({ queued: false }));
    const controller = setupController({
      client: { acp: { sendPrompt } },
    });
    const input = {
      conversationId: target.conversationId,
      promptId: crypto.randomUUID(),
      prompt: { text: 'hello' },
    };

    await expect(controller.call('acp.sendPrompt', input)).resolves.toEqual(ok({ queued: false }));

    expect(sendPrompt).toHaveBeenCalledWith(input, { timeoutMs: 0 });
  });

  it.each(['UNKNOWN_PROCEDURE', 'DISCONNECTED', 'TIMEOUT'] as const)(
    'does not resend a prompt after %s',
    async (code) => {
      const sendPrompt = vi.fn().mockRejectedValue(new WireError(code, 'submission failed'));
      const controller = setupController({ client: { acp: { sendPrompt } } });
      const input = {
        conversationId: target.conversationId,
        promptId: crypto.randomUUID(),
        prompt: { text: 'hello' },
      };
      await expect(controller.call('acp.sendPrompt', input)).rejects.toMatchObject({ code });
      expect(sendPrompt).toHaveBeenCalledOnce();
    }
  );

  it('records submitted TUI input only after a successful carriage return', async () => {
    const sendInput = vi.fn(async () => ok(undefined));
    const recordTuiInput = vi.fn(async () => {});
    const controller = setupController({
      client: { tuiAgents: { sendInput } },
      hooks: { recordTuiInput },
    });

    await controller.call('tui.sendInput', {
      conversationId: target.conversationId,
      data: 'hello',
    });
    expect(recordTuiInput).not.toHaveBeenCalled();

    await controller.call('tui.sendInput', {
      conversationId: target.conversationId,
      data: '\r',
    });
    expect(recordTuiInput).toHaveBeenCalledOnce();
    expect(recordTuiInput).toHaveBeenCalledWith(target);
  });

  it.each(['acp', 'pty'] as const)(
    'routes %s attachments to the conversation host',
    async (conversationType) => {
      const remoteHost = hostRef('remote', 'ssh-attachments');
      const resolvedHosts: HostRef[] = [];
      const uploadAttachment = vi.fn(async (_input: { conversationId: string }, _file: WireFile) =>
        ok({
          id: 'attachment-1',
          name: 'image.png',
          mimeType: 'image/png' as const,
          pathStyle: 'posix' as const,
          targetPath: '/host/attachments/image.png',
        })
      );
      const downloadAttachment = vi.fn(async () =>
        ok({
          meta: {
            id: 'attachment-1',
            name: 'image.png',
            mimeType: 'image/png' as const,
            pathStyle: 'posix' as const,
            targetPath: '/host/attachments/image.png',
          },
          chunks: async function* () {
            yield new Uint8Array([1, 2, 3]);
          },
        })
      );
      const controller = setupController({
        conversationType,
        host: remoteHost,
        resolvedHosts,
        client: {
          conversations: {
            attachments: { upload: uploadAttachment, download: downloadAttachment },
          },
        },
      });
      const file = fakeWireFile();

      await controller.call(
        'attachments.upload',
        { conversationId: target.conversationId },
        { uploadFile: file }
      );
      expect(uploadAttachment).toHaveBeenCalledWith(
        { conversationId: target.conversationId },
        expect.objectContaining({ name: file.name, mimeType: file.mimeType, size: file.size }),
        {}
      );
      expect(resolvedHosts).toEqual([remoteHost]);
      expect(await uploadAttachment.mock.calls[0][1].bytes()).toEqual(await file.bytes());

      const result = await controller.call('attachments.download', {
        conversationId: target.conversationId,
        attachmentId: 'attachment-1',
      });
      expect(downloadAttachment).toHaveBeenCalledWith(
        { conversationId: target.conversationId, attachmentId: 'attachment-1' },
        {}
      );
      expect(isDownloadFileOpenResult(result)).toBe(true);
      if (!isDownloadFileOpenResult(result)) throw new Error('Expected a download result');
      const chunks: Uint8Array[] = [];
      for await (const chunk of result.data.source as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual([new Uint8Array([1, 2, 3])]);

      const cancelled = await controller.call('attachments.download', {
        conversationId: target.conversationId,
        attachmentId: 'attachment-1',
      });
      if (!isDownloadFileOpenResult(cancelled)) throw new Error('Expected a download result');
      const iterator = (cancelled.data.source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
      await iterator.return?.();
    }
  );

  it('resolves the client for each attached ACP session state', async () => {
    const source: LiveSource = {
      snapshot: async () => ({
        generation: 1,
        sequence: 0,
        timestamp: 0,
        data: { lifecycle: 'active' },
      }),
      subscribe: () => () => {},
    };
    const state = vi.fn(() => ({ asLiveSource: () => source }));
    const controller = setupController({
      client: { acp: { session: { state } } },
    });
    const topic = encodeTopic(conversationsContract.acp.session.states.state.id, {
      conversationId: target.conversationId,
    });

    const lease = controller.acquireLive(topic);
    expect(lease).not.toBeNull();
    await expect(lease?.ready()).resolves.toBe(source);

    await lease?.release();
  });

  it('forwards aggregate ACP sessions through the host encoded in the desktop key', async () => {
    const remoteHost = hostRef('remote', 'ssh-1');
    const resolvedHosts: HostRef[] = [];
    const source: LiveSource = {
      snapshot: async () => ({ generation: 1, sequence: 0, timestamp: 0, data: {} }),
      subscribe: () => () => {},
    };
    const state = vi.fn(() => ({ asLiveSource: () => source }));
    const controller = setupController({
      client: { acp: { sessions: { state } } },
      resolvedHosts,
    });
    const topic = encodeTopic(conversationsContract.acp.sessions.states.list.id, {
      host: formatHostRef(remoteHost),
      projectId: target.projectId,
    });

    const lease = controller.acquireLive(topic);
    await expect(lease?.ready()).resolves.toBe(source);

    expect(resolvedHosts).toEqual([remoteHost]);
    expect(state).toHaveBeenCalledWith(undefined, 'list');
    await lease?.release();
  });

  it('forwards aggregate TUI sessions through the host encoded in the desktop key', async () => {
    const remoteHost = hostRef('remote', 'ssh-2');
    const resolvedHosts: HostRef[] = [];
    const source: LiveSource = {
      snapshot: async () => ({ generation: 1, sequence: 0, timestamp: 0, data: {} }),
      subscribe: () => () => {},
    };
    const state = vi.fn(() => ({ asLiveSource: () => source }));
    const controller = setupController({
      client: { tuiAgents: { sessions: { state } } },
      resolvedHosts,
    });
    const topic = encodeTopic(conversationsContract.tui.sessions.states.list.id, {
      host: formatHostRef(remoteHost),
      projectId: target.projectId,
    });

    const lease = controller.acquireLive(topic);
    await expect(lease?.ready()).resolves.toBe(source);

    expect(resolvedHosts).toEqual([remoteHost]);
    expect(state).toHaveBeenCalledWith(undefined, 'list');
    await lease?.release();
  });

  it('returns RuntimeResolveError from fallible conversation procedures and downloads', async () => {
    const resolveError: RuntimeResolveError = {
      type: 'host-unavailable',
      host: LOCAL_HOST_REF,
      reason: 'runtime-unavailable',
      message: 'Runtime unavailable',
    };
    const controller = setupController({
      client: {},
      runtimeError: resolveError,
    });

    await expect(
      controller.call('acp.loadHistory', {
        conversationId: target.conversationId,
        limit: 50,
      })
    ).resolves.toEqual(err(resolveError));
    await expect(
      controller.call('attachments.download', {
        conversationId: target.conversationId,
        attachmentId: 'attachment-1',
      })
    ).resolves.toEqual(err(resolveError));
  });

  it('requires effective project attachment before live conversation calls', async () => {
    const resolvedHosts: HostRef[] = [];
    const attachmentError = {
      type: 'project-missing' as const,
      projectId: target.projectId,
    };
    const controller = setupController({
      client: {},
      attachmentError,
      resolvedHosts,
    });

    await expect(
      controller.call('acp.sendPrompt', {
        conversationId: target.conversationId,
        promptId: '00000000-0000-4000-8000-000000000001',
        prompt: { text: 'hello' },
      })
    ).resolves.toEqual(err(attachmentError));
    await expect(
      controller.call('dehydrateConversation', {
        projectId: target.projectId,
        taskId: target.taskId,
        conversationId: target.conversationId,
      })
    ).resolves.toEqual(err(attachmentError));
    const topic = encodeTopic(conversationsContract.acp.sessions.states.list.id, {
      host: formatHostRef(LOCAL_HOST_REF),
      projectId: target.projectId,
    });
    const lease = controller.acquireLive(topic);
    await expect(lease?.ready()).rejects.toThrow('project-missing');
    await lease?.release();
    expect(resolvedHosts).toEqual([]);
  });
});

describe('conversation MCP servers', () => {
  it('adds provider servers to the ACP attach input only', async () => {
    const attach = vi.fn(async () => ok(undefined));
    const sendPrompt = vi.fn(async () => ok({ queued: false }));
    const browser = fakeBrowserProvider(browserSpec);
    const controller = setupController({
      client: { acp: { attach, sendPrompt } },
      workspaceId: 'workspace-1',
      conversationMcpServers: [browser.provider],
    });

    await expect(
      controller.call('acp.attach', { conversationId: target.conversationId })
    ).resolves.toEqual(ok(undefined));
    expect(attach).toHaveBeenCalledWith(
      { ...target.acpInput, mcpServers: [browserSpec(browser.contexts[0]!)] },
      {}
    );
    expect(browser.contexts).toEqual([
      {
        conversationId: target.conversationId,
        projectId: target.projectId,
        taskId: target.taskId,
        workspaceId: 'workspace-1',
        host: LOCAL_HOST_REF,
      },
    ]);

    await controller.call('acp.sendPrompt', {
      conversationId: target.conversationId,
      promptId: '00000000-0000-4000-8000-000000000001',
      prompt: { text: 'hello' },
    });
    expect(browser.contexts).toHaveLength(1);
  });

  it('starts the session without a failing provider', async () => {
    const attach = vi.fn(async () => ok(undefined));
    const warn = vi.fn();
    const controller = setupController({
      client: { acp: { attach } },
      workspaceId: 'workspace-1',
      logger: { warn },
      conversationMcpServers: [
        {
          conversationMcpServers: async () => {
            throw new Error('ssh down');
          },
        },
      ],
    });

    await expect(
      controller.call('acp.attach', { conversationId: target.conversationId })
    ).resolves.toEqual(ok(undefined));
    expect(attach).toHaveBeenCalledWith(target.acpInput, {});
    expect(warn).toHaveBeenCalledWith(
      'Conversation MCP server unavailable; starting the session without it',
      { conversationId: target.conversationId, error: 'Error: ssh down' }
    );
  });

  it('does not hold the session start for a slow provider', async () => {
    vi.useFakeTimers();
    try {
      const attach = vi.fn(async () => ok(undefined));
      const warn = vi.fn();
      const controller = setupController({
        client: { acp: { attach } },
        workspaceId: 'workspace-1',
        logger: { warn },
        conversationMcpServers: [{ conversationMcpServers: () => new Promise(() => {}) }],
      });

      const attached = controller.call('acp.attach', { conversationId: target.conversationId });
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(attached).resolves.toEqual(ok(undefined));
      expect(attach).toHaveBeenCalledWith(target.acpInput, {});
      expect(warn).toHaveBeenCalledWith(
        'Conversation MCP server unavailable; starting the session without it',
        {
          conversationId: target.conversationId,
          error: 'Error: Timed out preparing the MCP server',
        }
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('never replaces servers already in the start input', async () => {
    const attach = vi.fn(async () => ok(undefined));
    const conductor = { name: 'orkestra', command: '/conductor', args: ['bridge.cjs'] };
    const browser = fakeBrowserProvider(browserSpec);
    const controller = setupController({
      client: { acp: { attach } },
      workspaceId: 'workspace-1',
      acpMcpServers: [conductor],
      conversationMcpServers: [
        { conversationMcpServers: async () => [{ name: 'orkestra', command: 'x', args: [] }] },
        browser.provider,
      ],
    });

    await controller.call('acp.attach', { conversationId: target.conversationId });
    expect(attach).toHaveBeenCalledWith(
      { ...target.acpInput, mcpServers: [conductor, browserSpec(browser.contexts[0]!)] },
      {}
    );
  });

  it('merges the browser server with the conductor bridge on local hosts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orkestra-conversation-mcp-'));
    const scope = createScope({ label: 'test-orchestra' });
    try {
      const attach = vi.fn(async (_input: { mcpServers?: AgentToolsMcpServer[] }) => ok(undefined));
      const browser = fakeBrowserProvider(browserSpec);
      const controller = setupController({
        client: { acp: { attach } },
        workspaceId: 'workspace-1',
        conversationMcpServers: [browser.provider],
        orchestra: { dataDirectory: directory, electronExecutable: process.execPath, scope },
      });

      await controller.call('acp.attach', { conversationId: target.conversationId });
      expect(attach.mock.calls[0]![0].mcpServers?.map((server) => server.name)).toEqual([
        'orkestra-browser',
      ]);

      await controller.call('orchestra.register', {
        conversationId: target.conversationId,
        projectId: target.projectId,
        taskId: target.taskId,
        settings: orchestraSettings,
      });
      await controller.call('acp.attach', { conversationId: target.conversationId });
      const servers = attach.mock.calls[1]![0].mcpServers!;
      expect(servers.map((server) => server.name)).toEqual(['orkestra', 'orkestra-browser']);
      expect(servers[0]).toMatchObject({
        command: process.execPath,
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          ORKESTRA_ORCHESTRA_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/rpc$/),
          ORKESTRA_ORCHESTRA_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      });
      expect(servers[1]).toEqual(browserSpec(browser.contexts[1]!));
    } finally {
      await scope.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('merges the browser server with the conductor bridge on remote hosts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orkestra-conversation-mcp-'));
    const scope = createScope({ label: 'test-orchestra' });
    const remote = hostRef('remote', 'conn-1');
    const bridgeInputs: AgentToolsBridgeServerInput[] = [];
    const agentTools: AgentToolsBridgeHost = {
      register: () => () => {},
      bridgeServer: async (input) => {
        bridgeInputs.push(input);
        return {
          name: input.name,
          command: '/home/dev/.orkestra/workspace-server/current/node',
          args: ['/home/dev/.orkestra/agent-tools/bridge.cjs'],
          env: {
            [input.env.socket]: '/home/dev/.orkestra/agent-tools/rpc.sock',
            [input.env.token]: input.token,
          },
        };
      },
    };
    try {
      const attach = vi.fn(async (_input: { mcpServers?: AgentToolsMcpServer[] }) => ok(undefined));
      const browser = fakeBrowserProvider(browserSpec);
      const controller = setupController({
        client: { acp: { attach } },
        host: remote,
        workspaceId: 'workspace-1',
        conversationMcpServers: [browser.provider],
        orchestra: {
          dataDirectory: directory,
          electronExecutable: process.execPath,
          scope,
          agentTools,
        },
      });
      await controller.call('orchestra.register', {
        conversationId: target.conversationId,
        projectId: target.projectId,
        taskId: target.taskId,
        settings: orchestraSettings,
      });

      await controller.call('acp.attach', { conversationId: target.conversationId });
      const servers = attach.mock.calls[0]![0].mcpServers!;
      expect(servers.map((server) => server.name)).toEqual(['orkestra', 'orkestra-browser']);
      expect(servers[0]!.env).toEqual({
        ORKESTRA_ORCHESTRA_SOCKET: '/home/dev/.orkestra/agent-tools/rpc.sock',
        ORKESTRA_ORCHESTRA_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(bridgeInputs[0]).toMatchObject({ name: 'orkestra', host: remote });
      expect(browser.contexts[0]?.host).toEqual(remote);
      expect(servers[1]?.command).toBe('/home/dev/node');
    } finally {
      await scope.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function setupController(options: {
  client: object;
  host?: HostRef;
  conversationType?: 'acp' | 'pty';
  runtimeError?: RuntimeResolveError;
  attachmentError?: { type: 'project-missing'; projectId: string };
  resolvedHosts?: HostRef[];
  hooks?: Partial<{
    persistAcpConfigOption: (
      target: TestRuntimeTarget,
      key: 'model' | 'modeId' | 'effort' | 'collaborationMode',
      value: string | null
    ) => Promise<void>;
    recordTuiInput: (target: TestRuntimeTarget) => Promise<void>;
  }>;
  logger?: { warn: (...args: unknown[]) => void };
  workspaceId?: string;
  acpMcpServers?: AgentToolsMcpServer[];
  conversationMcpServers?: ConversationMcpServerProvider[];
  orchestra?: CreateConversationsWireControllerOptions['orchestra'];
}) {
  const hooks = {
    persistAcpConfigOption: async () => {},
    recordTuiInput: async () => {},
    ...options.hooks,
  };
  return createConversationsWireController({
    terminalFileSources: { prepare: vi.fn() },
    db: {} as never,
    logger: (options.logger ?? { warn: vi.fn() }) as never,
    runtimes: {
      client: async (host: HostRef) => {
        options.resolvedHosts?.push(host);
        return options.runtimeError ? err(options.runtimeError) : ok(options.client);
      },
    } as never,
    workspaceIdentity: {} as never,
    sessionLaunchContexts: {} as never,
    telemetry: { capture: vi.fn() } as never,
    projects: {
      requireAttached: vi.fn(() =>
        options.attachmentError ? err(options.attachmentError) : ok({} as never)
      ),
    },
    taskSessions: { getTask: vi.fn() },
    withCompensation: async ({ action }) => action(),
    hostIsReachable: () => true,
    resolveTarget: async () => ({
      ...target,
      host: options.host ?? target.host,
      conversationType: options.conversationType ?? target.conversationType,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.acpMcpServers
        ? { acpInput: { ...target.acpInput, mcpServers: options.acpMcpServers } }
        : {}),
    }),
    hooks,
    ...(options.conversationMcpServers
      ? { conversationMcpServers: options.conversationMcpServers }
      : {}),
    ...(options.orchestra ? { orchestra: options.orchestra } : {}),
  });
}

const orchestraSettings: OrchestraSettings = {
  conductorProviderId: 'claude',
  conductorModel: null,
  workers: [{ providerId: 'codex', name: 'Codex', models: [] }],
  maxParallel: 0,
  autoApproveWorkers: false,
  routingNotes: '',
};

/** Tarayıcı araçlarının yerine geçen sağlayıcı; aldığı bağlamları kaydeder. */
function fakeBrowserProvider(spec: (context: ConversationToolContext) => AgentToolsMcpServer) {
  const contexts: ConversationToolContext[] = [];
  const provider: ConversationMcpServerProvider = {
    conversationMcpServers: async (context) => {
      contexts.push(context);
      return [spec(context)];
    },
  };
  return { provider, contexts };
}

const browserSpec = (context: ConversationToolContext): AgentToolsMcpServer => ({
  name: 'orkestra-browser',
  command: context.host.type === 'remote' ? '/home/dev/node' : '/electron',
  args: ['bridge.cjs'],
  env: {
    ORKESTRA_TOOLS_TOKEN: `token-${context.conversationId}`,
    ORKESTRA_TOOLS_SERVER: 'browser',
  },
});

function fakeWireFile(): WireFile {
  const data = new Uint8Array([1, 2, 3]);
  return {
    name: 'image.png',
    mimeType: 'image/png',
    size: data.byteLength,
    stream: async function* () {
      yield data;
    },
    bytes: async () => data,
    file: async () => ({
      name: 'image.png',
      mimeType: 'image/png',
      size: data.byteLength,
      stream: async function* () {
        yield data;
      },
    }),
    cancel: () => {},
  };
}
