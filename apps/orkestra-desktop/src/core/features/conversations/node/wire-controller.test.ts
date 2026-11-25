import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
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
import { summarizeManagedPolicy, validateManagedPolicy } from '@orkestra/shared/managed-policy';
import type { LiveSource } from '@orkestra/wire/rpc';
import {
  encodeTopic,
  isDownloadFileOpenResult,
  WireError,
  type WireFile,
} from '@orkestra/wire/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestraSettings } from '@core/features/orchestra/api/orchestra';
import { hostPathFromNative } from '@core/primitives/desktop-runtime/api';
import { setActiveManagedPolicy } from '@core/primitives/managed-policy/api/node/active-policy';
import type {
  AgentToolsMcpServer,
  ConversationMcpServerProvider,
  ConversationToolContext,
} from '@core/services/agent-tools/api/agent-tools';
import type {
  AgentToolsBridgeHost,
  AgentToolsBridgeServerInput,
} from '@core/services/agent-tools/node/agent-tools-host';
import { conversationsContract, MEDIA_PREVIEW_MAX_CHUNK_BYTES } from '../api';
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

  it('forwards a confirmed "continue with a new session" only on that attach', async () => {
    const attach = vi.fn(async () => ok(undefined));
    const controller = setupController({ client: { acp: { attach } } });

    await controller.call('acp.attach', {
      conversationId: target.conversationId,
      replaceUnloadableSession: true,
    });
    await controller.call('acp.attach', { conversationId: target.conversationId });

    expect(attach).toHaveBeenNthCalledWith(
      1,
      { ...target.acpInput, replaceUnloadableSession: true },
      {}
    );
    expect(attach).toHaveBeenNthCalledWith(2, target.acpInput, {});
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

  describe('checkpoints', () => {
    const checkout = hostPathFromNative(target.workspacePath);
    const promptInput = () => ({
      conversationId: target.conversationId,
      promptId: crypto.randomUUID(),
      prompt: { text: 'hello' },
    });

    it('snapshots the worktree before delivering the prompt', async () => {
      const calls: string[] = [];
      const createCheckpoint = vi.fn(async () => {
        calls.push('checkpoint');
        return ok({ checkpoint: {} });
      });
      const sendPrompt = vi.fn(async () => {
        calls.push('prompt');
        return ok({ queued: false });
      });
      const controller = setupController({
        client: { acp: { sendPrompt }, git: { checkout: { createCheckpoint } } },
      });
      const input = promptInput();

      await expect(controller.call('acp.sendPrompt', input)).resolves.toEqual(
        ok({ queued: false })
      );

      expect(calls).toEqual(['checkpoint', 'prompt']);
      expect(createCheckpoint).toHaveBeenCalledWith(
        {
          checkout,
          conversationId: target.conversationId,
          promptId: input.promptId,
          kind: 'prompt',
        },
        expect.objectContaining({ timeoutMs: expect.any(Number) })
      );
    });

    it.each([
      ['an error result', async () => err({ type: 'git_error', message: 'not a repository' })],
      [
        'a thrown error',
        async () => {
          throw new Error('host unreachable');
        },
      ],
    ])('still delivers the prompt when the checkpoint fails with %s', async (_name, fail) => {
      const warn = vi.fn();
      const sendPrompt = vi.fn(async () => ok({ queued: false }));
      const controller = setupController({
        client: { acp: { sendPrompt }, git: { checkout: { createCheckpoint: vi.fn(fail) } } },
        logger: { warn },
      });
      const input = promptInput();

      await expect(controller.call('acp.sendPrompt', input)).resolves.toEqual(
        ok({ queued: false })
      );

      expect(sendPrompt).toHaveBeenCalledWith(input, { timeoutMs: 0 });
      expect(warn).toHaveBeenCalledOnce();
    });

    it('lists, previews, and restores through the conversation worktree', async () => {
      const listCheckpoints = vi.fn(async () => ok({ checkpoints: [] }));
      const previewCheckpointRestore = vi.fn(async () =>
        ok({
          checkpoint: { seq: 2, hash: 'abc', createdAt: 0, kind: 'prompt' as const },
          files: [],
          recreate: 0,
          overwrite: 0,
          delete: 0,
          truncated: false,
        })
      );
      const restoreCheckpoint = vi.fn(async () =>
        ok({ safetySeq: 3, recreate: 0, overwrite: 0, delete: 0, skipped: [] })
      );
      const state = vi.fn(() => ({
        asLiveSource: () => ({ snapshot: async () => ({ data: { isGenerating: false } }) }),
      }));
      const controller = setupController({
        client: {
          acp: { session: { state } },
          git: { checkout: { listCheckpoints, previewCheckpointRestore, restoreCheckpoint } },
        },
      });
      const key = { conversationId: target.conversationId };

      await controller.call('checkpoints.list', key);
      await controller.call('checkpoints.preview', { ...key, seq: 2 });
      await expect(controller.call('checkpoints.restore', { ...key, seq: 2 })).resolves.toEqual(
        ok({ safetySeq: 3, recreate: 0, overwrite: 0, delete: 0, skipped: [] })
      );

      expect(listCheckpoints).toHaveBeenCalledWith({ checkout, ...key }, {});
      expect(previewCheckpointRestore).toHaveBeenCalledWith({ checkout, ...key, seq: 2 }, {});
      expect(restoreCheckpoint).toHaveBeenCalledWith({ checkout, ...key, seq: 2 }, {});
    });

    it('refuses to restore while the agent is generating', async () => {
      const restoreCheckpoint = vi.fn(async () => ok({ safetySeq: 3 }));
      const state = vi.fn(() => ({
        asLiveSource: () => ({ snapshot: async () => ({ data: { isGenerating: true } }) }),
      }));
      const controller = setupController({
        client: { acp: { session: { state } }, git: { checkout: { restoreCheckpoint } } },
      });

      await expect(
        controller.call('checkpoints.restore', { conversationId: target.conversationId, seq: 1 })
      ).resolves.toMatchObject({ success: false, error: { type: 'git_error' } });

      expect(restoreCheckpoint).not.toHaveBeenCalled();
    });

    it('drops the checkpoint refs when the conversation is deleted', async () => {
      const deleteCheckpoints = vi.fn(async () => ok({ deleted: 2 }));
      const controller = setupController({ client: { git: { checkout: { deleteCheckpoints } } } });

      await controller.call('deleteConversation', {
        projectId: target.projectId,
        taskId: target.taskId,
        conversationId: target.conversationId,
      });

      expect(deleteCheckpoints).toHaveBeenCalledWith({
        checkout,
        conversationId: target.conversationId,
      });
    });
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
        workspacePath: target.workspacePath,
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

  it('prepends the project memory index to the initial prompt as hidden context', async () => {
    const attach = vi.fn(async (_input: unknown) => ok(undefined));
    const promptContext = vi.fn(async (projectId: string) =>
      projectId === target.projectId ? '## Project memory\n- a: note' : null
    );
    const controller = setupController({
      client: { acp: { attach } },
      initialQueue: [{ text: 'do it', hiddenContext: 'issue' }, { text: 'second' }],
      projectMemory: { promptContext },
    });
    await controller.call('acp.attach', { conversationId: target.conversationId });
    expect(promptContext).toHaveBeenCalledWith(target.projectId);
    expect(attach.mock.calls[0]![0]).toMatchObject({
      initialQueue: [
        { text: 'do it', hiddenContext: '## Project memory\n- a: note\n\nissue' },
        { text: 'second' },
      ],
    });
  });

  it('leaves the initial prompt untouched when project memory is off or fails', async () => {
    const attach = vi.fn(async (_input: unknown) => ok(undefined));
    const queue = [{ text: 'do it' }];
    for (const promptContext of [
      async () => null,
      async () => {
        throw new Error('disk');
      },
    ]) {
      attach.mockClear();
      const controller = setupController({
        client: { acp: { attach } },
        initialQueue: queue,
        projectMemory: { promptContext },
      });
      await controller.call('acp.attach', { conversationId: target.conversationId });
      expect(attach.mock.calls[0]![0]).toMatchObject({ initialQueue: queue });
    }
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
      // Şef olmayan uzak konuşma yalnızca tarayıcı sunucusunu alır.
      await controller.call('acp.attach', { conversationId: target.conversationId });
      expect(attach.mock.calls[0]![0].mcpServers?.map((server) => server.name)).toEqual([
        'orkestra-browser',
      ]);
      expect(bridgeInputs).toEqual([]);

      await controller.call('orchestra.register', {
        conversationId: target.conversationId,
        projectId: target.projectId,
        taskId: target.taskId,
        settings: orchestraSettings,
      });
      await controller.call('acp.attach', { conversationId: target.conversationId });
      const servers = attach.mock.calls[1]![0].mcpServers!;
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
  initialQueue?: Array<{ text: string; hiddenContext?: string }>;
  projectMemory?: CreateConversationsWireControllerOptions['projectMemory'];
  remoteMedia?: CreateConversationsWireControllerOptions['remoteMedia'];
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
      ...(options.initialQueue
        ? { acpInput: { ...target.acpInput, initialQueue: options.initialQueue } }
        : {}),
    }),
    hooks,
    ...(options.conversationMcpServers
      ? { conversationMcpServers: options.conversationMcpServers }
      : {}),
    ...(options.orchestra ? { orchestra: options.orchestra } : {}),
    ...(options.projectMemory ? { projectMemory: options.projectMemory } : {}),
    ...(options.remoteMedia ? { remoteMedia: options.remoteMedia } : {}),
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

describe('managed policy on session start and mode switches', () => {
  function activate(limits: Record<string, unknown>) {
    const result = validateManagedPolicy(
      { schemaVersion: 1, organization: 'Example Corp', limits },
      { source: '/test/policy.json' }
    );
    if (!result.success) throw new Error(result.error.reason);
    const meta = { source: '/test/policy.json', fingerprint: 'abc' };
    setActiveManagedPolicy({
      ...meta,
      policy: result.data,
      summary: summarizeManagedPolicy(result.data, meta),
    });
  }

  afterEach(() => setActiveManagedPolicy(undefined));

  it('starts the session in the ceiling mode', async () => {
    activate({ maxPermissionMode: 'plan' });
    const attach = vi.fn(async () => ok(undefined));
    const controller = setupController({ client: { acp: { attach } } });
    await controller.call('acp.attach', { conversationId: target.conversationId });
    expect(attach).toHaveBeenCalledWith({ ...target.acpInput, modeId: 'plan' }, {});
  });

  it('refuses to start a denied agent', async () => {
    activate({ providers: { denied: ['claude'] } });
    const attach = vi.fn(async () => ok(undefined));
    const controller = setupController({ client: { acp: { attach } } });
    await expect(
      controller.call('acp.attach', { conversationId: target.conversationId })
    ).rejects.toThrow(/does not allow the "claude" agent/);
    expect(attach).not.toHaveBeenCalled();
  });

  it('refuses switching to a mode above the ceiling', async () => {
    activate({ maxPermissionMode: 'default' });
    const setOption = vi.fn(async () => ok(undefined));
    const controller = setupController({ client: { acp: { setOption } } });
    await expect(
      controller.call('acp.setOption', {
        conversationId: target.conversationId,
        key: 'mode',
        value: 'bypassPermissions',
      })
    ).resolves.toMatchObject({
      success: false,
      error: { type: 'set_mode_failed', cause: { message: expect.stringMatching(/Example Corp/) } },
    });
    expect(setOption).not.toHaveBeenCalled();
    await expect(
      controller.call('acp.setOption', {
        conversationId: target.conversationId,
        key: 'mode',
        value: 'plan',
      })
    ).resolves.toEqual(ok(undefined));
  });
});

describe('readMediaPreview (phone media ranges)', () => {
  it('serves bounded ranges anywhere in a large sparse file without a size cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orkestra-media-range-'));
    const filePath = join(directory, 'render.mp4');
    const size = 700 * 1024 * 1024;
    const markerOffset = 650 * 1024 * 1024;
    const marker = Buffer.from('SOVRA-RANGE-MARKER');
    const fh = await open(filePath, 'w');
    try {
      // Sparse: only the marker and the last byte are written; nothing near 700 MB hits the disk.
      await fh.truncate(size);
      await fh.write(marker, 0, marker.length, markerOffset);
      await fh.write(Buffer.from([0x7a]), 0, 1, size - 1);
    } finally {
      await fh.close();
    }
    try {
      const controller = setupController({ client: {} });
      const mid = (await controller.call('readMediaPreview', {
        conversationId: target.conversationId,
        uri: filePath,
        offset: markerOffset,
        maxBytes: 4096,
      })) as {
        size: number;
        offset: number;
        base64: string;
        eof: boolean;
        mimeType: string;
        maxChunkBytes?: number;
      };
      expect(mid.size).toBe(size);
      expect(mid.offset).toBe(markerOffset);
      expect(mid.eof).toBe(false);
      expect(mid.mimeType).toBe('video/mp4');
      expect(mid.maxChunkBytes).toBe(MEDIA_PREVIEW_MAX_CHUNK_BYTES);
      const midBytes = Buffer.from(mid.base64, 'base64');
      expect(midBytes.length).toBe(4096);
      expect(midBytes.subarray(0, marker.length).toString()).toBe('SOVRA-RANGE-MARKER');

      const tail = (await controller.call('readMediaPreview', {
        conversationId: target.conversationId,
        uri: `file://${filePath}`,
        offset: size - 10,
        maxBytes: MEDIA_PREVIEW_MAX_CHUNK_BYTES,
      })) as { base64: string; eof: boolean };
      const tailBytes = Buffer.from(tail.base64, 'base64');
      expect(tailBytes.length).toBe(10);
      expect(tailBytes[9]).toBe(0x7a);
      expect(tail.eof).toBe(true);

      // A full-size chunk stays bounded and fits the 16 MiB remote frame once base64-encoded.
      const big = (await controller.call('readMediaPreview', {
        conversationId: target.conversationId,
        uri: filePath,
        offset: 0,
        maxBytes: MEDIA_PREVIEW_MAX_CHUNK_BYTES,
      })) as { base64: string };
      expect(Buffer.from(big.base64, 'base64').length).toBe(MEDIA_PREVIEW_MAX_CHUNK_BYTES);
      expect(big.base64.length).toBeLessThan(16 * 1024 * 1024 - 64 * 1024);

      await expect(
        controller.call('readMediaPreview', {
          conversationId: target.conversationId,
          uri: filePath,
          offset: 0,
          maxBytes: MEDIA_PREVIEW_MAX_CHUNK_BYTES + 1,
        })
      ).rejects.toBeTruthy();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps refusing sensitive paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orkestra-media-range-'));
    const secret = join(directory, '.env');
    await writeFile(secret, 'TOKEN=x');
    try {
      const controller = setupController({ client: {} });
      await expect(
        controller.call('readMediaPreview', {
          conversationId: target.conversationId,
          uri: secret,
          offset: 0,
          maxBytes: 1024,
        })
      ).rejects.toThrow(/izni yok/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('readMediaPreview on a remote (SSH) workspace', () => {
  const huawei = hostRef('remote', 'conn-huawei');
  const video = '/home/u/projects/koroglu/out/koroglu_reel_instagram.mp4';
  const videoBytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));

  /** A fake SSH host: files exist only here, never on this Mac. */
  function fakeRemoteHost(
    files: Record<string, Buffer>,
    links: Record<string, string> = {},
    home = '/home/u'
  ) {
    const reads: Array<{ host: HostRef; path: string; offset: number; length: number }> = [];
    const resolved: string[] = [];
    const notFound = () => Object.assign(new Error('Dosya bulunamadı.'), { type: 'not-found' });
    const remoteMedia: NonNullable<CreateConversationsWireControllerOptions['remoteMedia']> = {
      reader: {
        homeDirectory: async () => home,
        resolve: async (_host, path) => {
          resolved.push(path);
          const realPath = links[path] ?? path;
          const file = files[realPath];
          if (!file) throw notFound();
          return { realPath, size: file.length };
        },
        read: async (host, path, range) => {
          reads.push({ host, path, ...range });
          const file = files[path];
          if (!file) throw notFound();
          return file.subarray(range.offset, range.offset + range.length);
        },
      },
      hostLabel: async (host) => (host.id === 'conn-huawei' ? 'huawei' : undefined),
    };
    return { remoteMedia, reads, resolved };
  }

  it('reads the range on the conversation host, not on this Mac', async () => {
    const remote = fakeRemoteHost({ [video]: videoBytes });
    const controller = setupController({
      client: {},
      host: huawei,
      remoteMedia: remote.remoteMedia,
    });
    const res = (await controller.call('readMediaPreview', {
      conversationId: target.conversationId,
      uri: video,
      offset: 1000,
      maxBytes: 1024,
    })) as { name: string; mimeType: string; size: number; base64: string; eof: boolean };
    expect(res).toMatchObject({
      name: 'koroglu_reel_instagram.mp4',
      mimeType: 'video/mp4',
      size: videoBytes.length,
      eof: false,
    });
    expect(Buffer.from(res.base64, 'base64')).toEqual(videoBytes.subarray(1000, 2024));
    // Only the requested range crosses the wire to the host: no whole-file reads.
    expect(remote.reads).toEqual([{ host: huawei, path: video, offset: 1000, length: 1024 }]);
  });

  it('resolves file: URIs, ~/ and workspace-relative paths on the remote host', async () => {
    const md = '/repo/bolumler/009/PAYLASIM.md';
    const remote = fakeRemoteHost({
      [video]: videoBytes,
      [md]: Buffer.from('# Paylasim'),
      '/home/u/notes/teslim.md': Buffer.from('teslim'),
    });
    const controller = setupController({
      client: {},
      host: huawei,
      remoteMedia: remote.remoteMedia,
    });
    const call = (uri: string) =>
      controller.call('readMediaPreview', {
        conversationId: target.conversationId,
        uri,
        offset: 0,
        maxBytes: 4096,
      }) as Promise<{ name: string; base64: string; eof: boolean; mimeType: string }>;

    const fromUri = await call('file:///home/u/projects/koroglu/out/koroglu_reel_instagram.mp4');
    expect(fromUri.name).toBe('koroglu_reel_instagram.mp4');
    expect(fromUri.eof).toBe(true);
    const relative = await call('bolumler/009/PAYLASIM.md');
    expect(Buffer.from(relative.base64, 'base64').toString()).toBe('# Paylasim');
    expect(relative.mimeType).toBe('text/markdown');
    const home = await call('~/notes/teslim.md');
    expect(Buffer.from(home.base64, 'base64').toString()).toBe('teslim');
    expect(remote.resolved).toEqual([video, md, '/home/u/notes/teslim.md']);
  });

  it('names the conversation host when the file is missing there', async () => {
    const remote = fakeRemoteHost({});
    const controller = setupController({
      client: {},
      host: huawei,
      remoteMedia: remote.remoteMedia,
    });
    await expect(
      controller.call('readMediaPreview', {
        conversationId: target.conversationId,
        uri: '/home/u/missing.mp4',
        offset: 0,
        maxBytes: 4096,
      })
    ).rejects.toThrow('Dosya bulunamadı (huawei).');
    expect(remote.reads).toEqual([]);
  });

  it('keeps the sensitive-path denylist, also behind symlinks', async () => {
    const remote = fakeRemoteHost(
      { '/home/u/.ssh/id_ed25519': Buffer.from('KEY') },
      { '/home/u/out/innocent.mp4': '/home/u/.ssh/id_ed25519' }
    );
    const controller = setupController({
      client: {},
      host: huawei,
      remoteMedia: remote.remoteMedia,
    });
    for (const uri of ['/home/u/.ssh/id_ed25519', '/home/u/out/innocent.mp4', '/etc/passwd']) {
      await expect(
        controller.call('readMediaPreview', {
          conversationId: target.conversationId,
          uri,
          offset: 0,
          maxBytes: 4096,
        })
      ).rejects.toThrow(/izni yok/);
    }
    expect(remote.reads).toEqual([]);
  });

  it('never consults the remote host for a local conversation', async () => {
    const remote = fakeRemoteHost({ [video]: videoBytes });
    const controller = setupController({ client: {}, remoteMedia: remote.remoteMedia });
    await expect(
      controller.call('readMediaPreview', {
        conversationId: target.conversationId,
        uri: '/nonexistent-orkestra-test/koroglu_reel_instagram.mp4',
        offset: 0,
        maxBytes: 4096,
      })
    ).rejects.toThrow(/ENOENT/);
    expect(remote.resolved).toEqual([]);
  });
});
