import type { TranscriptTurn } from '@orkestra/chat-ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildForkPrefixTurns,
  forkConversationToNewTask,
  forkTaskTitle,
  sliceTurnsUpToItem,
} from './fork-to-task';
import { getCachedPrefixTurns, getHandoffStore } from './handoff-store';

const { loadHistoryMock, createTaskMock, navigateMock } = vi.hoisted(() => ({
  loadHistoryMock: vi.fn(),
  createTaskMock: vi.fn(async () => undefined),
  navigateMock: vi.fn(),
}));

vi.mock('@core/features/conversations/api/browser/client', () => ({
  getConversationsClient: async () => ({
    acp: { loadHistory: loadHistoryMock },
  }),
}));

vi.mock('@core/features/conversations/api/browser/stores/conversation-registry', () => ({
  conversationRegistry: {
    get: () => ({
      conversations: new Map([
        [
          'conv-src',
          {
            data: {
              id: 'conv-src',
              title: 'Antigravity',
              providerId: 'antigravity',
              model: 'gemini-4-neon-high',
              autoApprove: true,
              modeId: 'auto',
            },
          },
        ],
      ]),
    }),
  },
}));

vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  asProvisioned: (s: unknown) => s,
  getTaskStore: () => ({ workspaceId: 'ws-task-1' }),
  getRegisteredTaskData: () => ({ id: 'task-1', name: 'Selamlaşma' }),
  getTaskManagerStore: () => ({ createTask: createTaskMock }),
}));

vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectStore: () => ({ data: { repositoryWorkspaceId: 'ws-repo-fallback' } }),
  projectData: (s: { data?: { repositoryWorkspaceId?: string } } | undefined) => s?.data ?? null,
}));

vi.mock('@core/primitives/navigation/browser/navigation-selectors', () => ({
  getNavigation: () => ({ navigate: navigateMock }),
}));

function makeTurn(id: string, seq: number, suffix: string): TranscriptTurn {
  return {
    id,
    seq,
    initiator: 'user',
    items: [
      { kind: 'message', id: `user-${suffix}`, seq: 0, role: 'user', text: `Soru ${suffix}` },
      { kind: 'message', id: `ai-${suffix}`, seq: 1, role: 'assistant', text: `Yanıt ${suffix}` },
    ],
  };
}

describe('forkTaskTitle', () => {
  it('appends fork cleanly without duplicating on repeated forks', () => {
    expect(forkTaskTitle('Selamlaşma')).toBe('Selamlaşma fork');
    expect(forkTaskTitle('Selamlaşma fork')).toBe('Selamlaşma fork');
    expect(forkTaskTitle('Selamlaşma (çatal)')).toBe('Selamlaşma fork');
    expect(forkTaskTitle('   ')).toBe('Sohbet fork');
  });
});

describe('sliceTurnsUpToItem & buildForkPrefixTurns', () => {
  it('slices turns inclusively up to target item id and builds sequential negative prefix turns', () => {
    const turns = [makeTurn('t1', 0, '1'), makeTurn('t2', 1, '2')];
    const sliced = sliceTurnsUpToItem(turns, 'ai-1');
    expect(sliced).toHaveLength(1);
    expect(sliced[0]!.items.map((i) => i.id)).toEqual(['user-1', 'ai-1']);

    const prefixed = buildForkPrefixTurns(sliced);
    expect(prefixed).toHaveLength(1);
    expect(prefixed[0]!.id).toBe('fork:t:0:t1');
    expect(prefixed[0]!.seq).toBe(-1_000_000);
    expect(prefixed[0]!.items.map((i) => i.id)).toEqual(['fork:i:0:user-1', 'fork:i:0:ai-1']);
  });
});

describe('forkConversationToNewTask', () => {
  beforeEach(() => {
    loadHistoryMock.mockReset();
    createTaskMock.mockClear();
    navigateMock.mockClear();
  });

  it('creates a new sidebar task reusing workspace, populates prefix turns, stores hidden context, and navigates', async () => {
    const turns = [makeTurn('t1', 0, '1'), makeTurn('t2', 1, '2')];
    loadHistoryMock.mockResolvedValueOnce({
      success: true,
      data: { turns, nextCursor: null },
    });

    const result = await forkConversationToNewTask({
      projectId: 'proj-1',
      taskId: 'task-1',
      sourceConversationId: 'conv-src',
      providerId: 'antigravity',
      model: 'gemini-4-neon-high',
      autoApprove: true,
      modeId: 'auto',
      effort: 'high',
      upToItemId: 'ai-1',
      fallbackTurns: turns,
    });

    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: result.taskId,
        projectId: 'proj-1',
        taskConfig: expect.objectContaining({
          name: 'Selamlaşma fork',
          initialConversation: expect.objectContaining({
            id: result.conversationId,
            provider: 'antigravity',
            model: 'gemini-4-neon-high',
            autoApprove: true,
            modeId: 'auto',
          }),
        }),
        workspaceConfig: {
          version: '2',
          git: { kind: 'none' },
          workspace: { kind: 'repository-instance', workspaceId: 'ws-task-1' },
        },
      })
    );

    const cached = getCachedPrefixTurns(result.conversationId);
    expect(cached).toHaveLength(1);
    expect(cached?.[0]?.items.map((i) => i.id)).toEqual(['fork:i:0:user-1', 'fork:i:0:ai-1']);

    const record = getHandoffStore().get(result.conversationId);
    expect(record).toMatchObject({
      mode: 'fork',
      sourceConversationId: 'conv-src',
      sourceTitle: 'Selamlaşma',
      sourceItemId: 'ai-1',
      contextDelivered: false,
      targetEffort: 'high',
    });
    expect(record?.context).toContain('Soru 1');
    expect(record?.context).not.toContain('Soru 2');

    expect(navigateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        viewId: 'task',
        params: { projectId: 'proj-1', taskId: result.taskId },
      })
    );
  });
});
