import { ok } from '@orkestra/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@core/primitives/conversations/api';
import {
  TuiConversationProvider,
  type TuiConversationProviderDependencies,
  type TuiConversationProviderOptions,
} from './tui-conversation-provider';

const start = vi.hoisted(() => vi.fn());
const resume = vi.hoisted(() => vi.fn());

describe('TuiConversationProvider', () => {
  beforeEach(() => {
    start.mockReset();
    resume.mockReset();
    start.mockResolvedValue(ok({ outcome: 'started' }));
    resume.mockResolvedValue(ok({ outcome: 'resumed' }));
  });

  it('routes fresh starts to the runtime start path with the initial prompt', async () => {
    const provider = createProvider();

    const result = await provider.ensureSession({
      conversation: conversation({ providerId: 'claude', sessionId: undefined }),
      mode: 'start',
      initialPrompt: 'hello',
    });

    expect(result).toEqual({ outcome: 'started' });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        providerId: 'claude',
        sessionId: null,
        initialPrompt: 'hello',
        trustWorkspace: false,
      })
    );
    expect(resume).not.toHaveBeenCalled();
  });

  it.each(['antigravity', 'codex', 'prime-agent'])(
    'routes native-id provider %s to the runtime resume path when a native id exists',
    async (providerId) => {
      const provider = createProvider();

      await provider.ensureSession({
        conversation: conversation({ providerId, sessionId: 'native-session' }),
        mode: 'resume',
        initialPrompt: 'do not replay',
      });

      expect(resume).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId,
          sessionId: 'native-session',
          initialPrompt: undefined,
        })
      );
      expect(start).not.toHaveBeenCalled();
    }
  );

  it.each([
    { providerId: 'antigravity', sessionId: undefined },
    { providerId: 'antigravity', sessionId: 'conversation-1' },
    { providerId: 'codex', sessionId: undefined },
    { providerId: 'codex', sessionId: 'conversation-1' },
    { providerId: 'prime-agent', sessionId: undefined },
    { providerId: 'prime-agent', sessionId: 'conversation-1' },
  ])(
    'starts $providerId fresh without replaying the prompt when sessionId is $sessionId',
    async ({ providerId, sessionId }) => {
      const provider = createProvider();

      await provider.ensureSession({
        conversation: conversation({ providerId, sessionId }),
        mode: 'resume',
        initialPrompt: 'do not replay',
      });

      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId,
          sessionId: null,
          initialPrompt: undefined,
        })
      );
      expect(resume).not.toHaveBeenCalled();
    }
  );

  it('resumes claude with a hook-captured session id that differs from the conversation id', async () => {
    const provider = createProvider();

    await provider.ensureSession({
      conversation: conversation({ providerId: 'claude', sessionId: 'native-session' }),
      mode: 'resume',
    });

    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'claude', sessionId: 'native-session' })
    );
    expect(start).not.toHaveBeenCalled();
  });

  it('resumes claude with the conversation id when no other session id was captured', async () => {
    const provider = createProvider();

    await provider.ensureSession({
      conversation: conversation({ providerId: 'claude', sessionId: 'conversation-1' }),
      mode: 'resume',
    });

    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'claude', sessionId: 'conversation-1' })
    );
  });

  it.each([
    { label: 'local', host: { type: 'local', id: 'local' } as const },
    { label: 'remote', host: { type: 'remote', id: 'ssh-1' } as const },
  ])('sends the settings-driven trust verdict to the $label runtime', async ({ host }) => {
    const provider = createProvider({ host, autoTrustWorktrees: true });

    await provider.ensureSession({
      conversation: conversation({ providerId: 'claude' }),
      mode: 'start',
    });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ trustWorkspace: true }));
  });

  it('forces runtime trust for auto-approved conversations without reading settings', async () => {
    const getTaskSettings = vi.fn(async () => ({ autoTrustWorktrees: false }));
    const provider = createProvider({
      host: { type: 'remote', id: 'ssh-1' },
      getTaskSettings,
    });

    await provider.ensureSession({
      conversation: conversation({ providerId: 'claude', autoApprove: true }),
      mode: 'start',
    });

    expect(getTaskSettings).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ trustWorkspace: true }));
  });

  it('resolves mutable task launch context immediately before each fresh start', async () => {
    let launchContext = {
      workspace: {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        host: { type: 'local', id: 'local' } as const,
        path: '/workspace',
      },
      tmux: false,
      shellSetup: 'source old-profile',
      env: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-old',
        ORKESTRA_TASK_NAME: 'old-name',
      },
    };
    const resolve = vi.fn(async () => ok(launchContext));
    const provider = createProvider({ launchContextSource: { resolve } });

    await provider.ensureSession({
      conversation: conversation({ id: 'conversation-1', providerId: 'claude' }),
      mode: 'start',
    });

    launchContext = {
      ...launchContext,
      tmux: true,
      shellSetup: 'source new-profile',
      env: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-new',
        ORKESTRA_TASK_NAME: 'new-name',
      },
    };
    await provider.ensureSession({
      conversation: conversation({ id: 'conversation-2', providerId: 'claude' }),
      mode: 'start',
    });

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerVars: expect.objectContaining({
          CLAUDE_CONFIG_DIR: '/tmp/claude-old',
          ORKESTRA_TASK_NAME: 'old-name',
        }),
        shellSetup: 'source old-profile',
      })
    );
    expect(start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerVars: expect.objectContaining({
          CLAUDE_CONFIG_DIR: '/tmp/claude-new',
          ORKESTRA_TASK_NAME: 'new-name',
        }),
        shellSetup: 'source new-profile',
        tmux: { identity: expect.stringMatching(/:/) },
      })
    );
  });
  it.each([
    { label: 'local', host: { type: 'local', id: 'local' } as const },
    { label: 'remote', host: { type: 'remote', id: 'ssh-1' } as const },
  ])('hands the $label conversation tool servers to the runtime', async ({ host }) => {
    const server = {
      name: 'orkestra-browser',
      command: '/remote/node',
      args: ['/remote/bridge.js'],
      env: { ORKESTRA_TOOLS_TOKEN: 'token' },
    };
    const resolveConversationMcpServers = vi.fn(async () => [server]);
    const provider = createProvider({ host, resolveConversationMcpServers });

    await provider.ensureSession({ conversation: conversation({}), mode: 'start' });

    expect(resolveConversationMcpServers).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      projectId: 'project-1',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      host,
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: [server] }));
  });

  it('starts without tool servers when none resolve or resolution fails', async () => {
    const empty = createProvider({ resolveConversationMcpServers: async () => [] });
    await empty.ensureSession({ conversation: conversation({}), mode: 'start' });
    expect(start.mock.calls[0]![0]).not.toHaveProperty('mcpServers');

    const failing = createProvider({
      resolveConversationMcpServers: async () => {
        throw new Error('tunnel down');
      },
    });
    await expect(
      failing.ensureSession({ conversation: conversation({}), mode: 'start' })
    ).resolves.toEqual({ outcome: 'started' });
    expect(start.mock.calls[1]![0]).not.toHaveProperty('mcpServers');
  });
});

function createProvider(
  overrides: {
    host?: TuiConversationProviderOptions['host'];
    autoTrustWorktrees?: boolean;
    getTaskSettings?: () => Promise<{ autoTrustWorktrees: boolean }>;
    launchContextSource?: TuiConversationProviderOptions['launchContextSource'];
    resolveConversationMcpServers?: TuiConversationProviderDependencies['resolveConversationMcpServers'];
  } = {}
): TuiConversationProvider {
  return new TuiConversationProvider(
    {
      host: overrides.host ?? { type: 'local', id: 'local' },
      tuiAgents: { start, resume } as never,
      projectId: 'project-1',
      taskId: 'task-1',
      taskPath: '/workspace',
      workspaceId: 'workspace-1',
      launchContextSource: overrides.launchContextSource ?? {
        resolve: async () =>
          ok({
            workspace: {
              workspaceId: 'workspace-1',
              projectId: 'project-1',
              host: overrides.host ?? { type: 'local', id: 'local' },
              path: '/workspace',
            },
            tmux: false,
            env: {},
          }),
      },
    },
    {
      db: { select: vi.fn() } as never,
      getProviderConfig: () => Promise.resolve(undefined),
      getTaskSettings:
        overrides.getTaskSettings ??
        (() => Promise.resolve({ autoTrustWorktrees: overrides.autoTrustWorktrees ?? false })),
      getTerminalColorEnv: () => Promise.resolve({}),
      resolveSessionGitCredentials: () => Promise.resolve(undefined),
      ...(overrides.resolveConversationMcpServers
        ? { resolveConversationMcpServers: overrides.resolveConversationMcpServers }
        : {}),
    }
  );
}

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: 'conversation-1',
    projectId: 'project-1',
    taskId: 'task-1',
    providerId: 'claude',
    title: 'Conversation',
    lastInteractedAt: null,
    isInitialConversation: false,
    type: 'pty',
    ...overrides,
  };
}
