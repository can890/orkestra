import type { Controller, LiveSource } from '@orkestra/wire/rpc';
import { describe, expect, it } from 'vitest';
import { createControllersBackend } from './controllers-backend';

// Arka ucun masaüstü denetleyicilerini arayüzün/mobilin kullandığı yollarla ve girdilerle
// çağırdığını doğrular (sahte denetleyicilerle; gerçek uygulama başlatılmaz).

type Call = { domain: string; path: string; input: unknown };

function fakeController(
  domain: string,
  calls: Call[],
  handlers: Record<string, (input: unknown) => unknown>,
  live: Record<string, unknown> = {}
): Controller {
  return {
    async call(path, input) {
      calls.push({ domain, path, input });
      const handler = handlers[path];
      if (!handler) throw new Error(`unexpected ${domain}.${path}`);
      return handler(input);
    },
    resolveLive(topic) {
      if (!(topic in live)) return null;
      const source: LiveSource = {
        snapshot: () => ({ data: live[topic] }) as never,
        subscribe: () => () => {},
      };
      return source;
    },
    acquireLive: () => null,
  };
}

function setup() {
  const calls: Call[] = [];
  const controllers = {
    projects: fakeController(
      'projects',
      calls,
      {},
      {
        'projectList.list': {
          projects: [
            {
              type: 'local',
              id: 'p1',
              name: 'Alpha',
              path: '/tmp/alpha',
              repositoryWorkspaceId: 'ws-1',
            },
            {
              type: 'ssh',
              id: 'p2',
              name: 'Remote',
              path: '/srv/x',
              connectionId: 'c1',
              repositoryWorkspaceId: null,
            },
          ],
        },
      }
    ),
    conversations: fakeController(
      'conversations',
      calls,
      {
        getConversations: () => [
          {
            id: 'c-1',
            projectId: 'p1',
            taskId: 't1',
            providerId: 'claude',
            title: 'Hello',
            type: 'acp',
            sessionId: 's',
            agentStatus: 'working',
            lastInteractedAt: null,
          },
          { id: 'broken' },
        ],
        'acp.attach': () => ({ success: true, data: {} }),
        'acp.sendPrompt': () => ({ success: true, data: { queued: true } }),
        'acp.loadHistory': () => ({
          success: true,
          data: {
            turns: [
              {
                id: 'turn',
                seq: 3,
                initiator: 'user',
                outcome: { kind: 'done' },
                items: [
                  { kind: 'message', id: 'm1', seq: 0, role: 'user', text: 'hi' },
                  { kind: 'thinking', id: 'th', seq: 1, text: 'secret thoughts' },
                  { kind: 'execute-tool-call', id: 'tc', seq: 2, title: 'ls', status: 'completed' },
                  {
                    kind: 'message',
                    id: 'm2',
                    seq: 3,
                    role: 'assistant',
                    text: 'hello',
                    createdAt: 5,
                  },
                ],
              },
            ],
            nextCursor: 3,
          },
        }),
      },
      {
        'acp.sessions.list|{"host":"local:local","projectId":"p1"}': {
          'c-1': {
            conversationId: 'c-1',
            providerId: 'claude',
            lifecycle: 'working',
            isGenerating: true,
            lastStopReason: null,
            lastTurnErrored: false,
            pendingPermissionCount: 1,
            backgroundAgentCount: 0,
            queuedPromptCount: 0,
            title: null,
            updatedAt: 1,
          },
        },
      }
    ),
    tasks: fakeController('tasks', calls, {
      createTask: () => ({ success: true, data: {} }),
    }),
    agents: fakeController('agents', calls, {
      list: () => ({
        success: true,
        data: [
          {
            id: 'claude',
            name: 'Claude Code',
            status: 'available',
            capabilities: {
              acp: { kind: 'supported' },
              effort: { kind: 'supported' },
              models: { kind: 'selectable', modelOptions: { opus: { name: 'Opus' } } },
            },
          },
          {
            id: 'tui-only',
            name: 'TUI',
            status: 'available',
            capabilities: { acp: { kind: 'none' } },
          },
        ],
      }),
    }),
  } satisfies Record<string, Controller>;
  return { calls, backend: createControllersBackend(controllers) };
}

describe('createControllersBackend', () => {
  it('reads projects from the project list live model', async () => {
    const { backend } = setup();
    expect(await backend.listProjects()).toEqual([
      {
        id: 'p1',
        name: 'Alpha',
        path: '/tmp/alpha',
        location: 'local',
        repositoryWorkspaceId: 'ws-1',
        hostKey: 'local:local',
      },
      {
        id: 'p2',
        name: 'Remote',
        path: '/srv/x',
        location: 'ssh',
        repositoryWorkspaceId: null,
        hostKey: 'remote:c1',
      },
    ]);
  });

  it('maps conversations, session summaries and history', async () => {
    const { backend } = setup();
    const conversations = await backend.listConversations();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({ id: 'c-1', type: 'acp', hasSession: true });
    const [project] = await backend.listProjects();
    const summaries = await backend.sessionSummaries(project!);
    expect(summaries['c-1']).toMatchObject({ pendingPermissionCount: 1, isGenerating: true });
    const history = await backend.loadLiveHistory('c-1', 5, undefined);
    expect(history).toEqual({
      turns: [
        {
          seq: 3,
          outcome: 'done',
          items: [
            { kind: 'message', role: 'user', text: 'hi', createdAt: null },
            { kind: 'tool', title: 'ls', status: 'completed' },
            { kind: 'message', role: 'assistant', text: 'hello', createdAt: 5 },
          ],
        },
      ],
      nextCursor: 3,
    });
  });

  it('lists only chat (ACP) providers with their models', async () => {
    const { backend } = setup();
    expect(await backend.listProviders()).toEqual([
      {
        id: 'claude',
        name: 'Claude Code',
        installed: true,
        supportsEffort: true,
        models: [{ id: 'opus', name: 'Opus' }],
      },
    ]);
  });

  it('starts a conversation through tasks.createTask and attaches its session', async () => {
    const { backend, calls } = setup();
    const [project] = await backend.listProjects();
    const result = await backend.startConversation({
      project: project!,
      provider: 'claude',
      title: 'Fix it',
      message: 'Please fix it',
      model: 'opus',
    });
    expect(result.started).toBe(true);
    const create = calls.find((entry) => entry.path === 'createTask');
    expect(create?.domain).toBe('tasks');
    expect(create?.input).toMatchObject({
      projectId: 'p1',
      taskConfig: {
        version: '1',
        name: 'Fix it',
        initialConversation: {
          id: result.conversationId,
          provider: 'claude',
          type: 'acp',
          initialPrompt: 'Please fix it',
          model: 'opus',
        },
      },
      workspaceConfig: {
        version: '2',
        git: { kind: 'none' },
        workspace: { kind: 'repository-instance', workspaceId: 'ws-1' },
      },
    });
    const attach = calls.find((entry) => entry.path === 'acp.attach');
    expect(attach?.input).toEqual({ conversationId: result.conversationId });
  });

  it('sends a message after attaching, with the requested placement', async () => {
    const { backend, calls } = setup();
    expect(await backend.sendMessage('c-1', 'next', 'queue')).toEqual({ queued: true });
    const paths = calls.map((entry) => entry.path);
    expect(paths.indexOf('acp.attach')).toBeLessThan(paths.indexOf('acp.sendPrompt'));
    const prompt = calls.find((entry) => entry.path === 'acp.sendPrompt')?.input as {
      prompt: unknown;
      placement: string;
      promptId: string;
    };
    expect(prompt.prompt).toEqual({ text: 'next' });
    expect(prompt.placement).toBe('queue');
    expect(prompt.promptId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
