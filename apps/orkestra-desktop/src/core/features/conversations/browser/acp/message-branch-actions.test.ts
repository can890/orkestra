import type { PrefixTranscriptTurn, TranscriptTurn } from '@orkestra/chat-ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumePendingDraftText,
  getCachedPrefixTurns,
  getHandoffStore,
} from '../handoff/handoff-store';
import {
  branchConversationFromBeforeItem,
  extractTargetTurnInfo,
  sliceTurnsBeforeItem,
  type BranchTurnLike,
} from './message-branch-actions';

const {
  loadHistoryMock,
  createConversationMock,
  openPaneMock,
  closeTabMock,
  setActiveGroupMock,
  findSingleMountEntryMock,
} = vi.hoisted(() => ({
  loadHistoryMock: vi.fn(),
  createConversationMock: vi.fn<(params: Record<string, unknown>) => Promise<undefined>>(
    async () => undefined
  ),
  openPaneMock: vi.fn(),
  closeTabMock: vi.fn(),
  setActiveGroupMock: vi.fn(),
  findSingleMountEntryMock: vi.fn(),
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
              title: 'Ana Sohbet',
              providerId: 'claude',
              model: 'claude-opus-5-5',
              autoApprove: true,
              modeId: 'auto',
              effort: 'medium',
              collaborationMode: 'default',
            },
          },
        ],
      ]),
      createConversation: createConversationMock,
    }),
  },
}));

vi.mock('@core/features/workbench/api/browser/task-composition-selectors', () => ({
  getTaskComposition: () => ({
    paneLayout: {
      groups: [
        {
          paneId: 'pane-1',
          pane: {
            findSingleMountEntry: findSingleMountEntryMock,
            closeTab: closeTabMock,
          },
        },
      ],
      focusedPane: null,
      setActiveGroup: setActiveGroupMock,
      open: openPaneMock,
    },
  }),
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

describe('sliceTurnsBeforeItem', () => {
  it('returns empty array when targeting the first turn', () => {
    const turns = [makeTurn('t1', 0, '1'), makeTurn('t2', 1, '2'), makeTurn('t3', 2, '3')];
    expect(sliceTurnsBeforeItem(turns, 'user-1')).toEqual([]);
  });

  it('returns only strictly prior turns when targeting a middle turn user item', () => {
    const turns = [makeTurn('t1', 0, '1'), makeTurn('t2', 1, '2'), makeTurn('t3', 2, '3')];
    const sliced = sliceTurnsBeforeItem(turns, 'user-2');
    expect(sliced.map((t) => t.id)).toEqual(['t1']);
  });

  it('returns strictly prior turns when targeting an assistant message itemId', () => {
    const turns = [makeTurn('t1', 0, '1'), makeTurn('t2', 1, '2'), makeTurn('t3', 2, '3')];
    const sliced = sliceTurnsBeforeItem(turns, 'ai-2');
    expect(sliced.map((t) => t.id)).toEqual(['t1']);
  });

  it('matches items inside nested children recursively', () => {
    const turns: BranchTurnLike[] = [
      makeTurn('t1', 0, '1'),
      {
        id: 't2',
        seq: 1,
        items: [
          { kind: 'message', id: 'user-2', role: 'user', text: 'Soru 2' },
          {
            kind: 'tool',
            id: 'tool-parent',
            children: [
              {
                kind: 'tool',
                id: 'tool-child',
                children: [{ kind: 'diff', id: 'nested-leaf-id' }],
              },
            ],
          },
        ],
      },
      makeTurn('t3', 2, '3'),
    ];
    expect(sliceTurnsBeforeItem(turns, 'nested-leaf-id').map((t) => t.id)).toEqual(['t1']);
  });

  it('handles prefix turns cleanly when branching an already branched/handed-off history', () => {
    const prefixTurn: PrefixTranscriptTurn = {
      id: 'fork:t:0:t0',
      seq: -1_000_000,
      initiator: 'user',
      items: [
        { kind: 'message', id: 'fork:i:0:user-0', seq: 0, role: 'user', text: 'Ön Soru' },
        { kind: 'message', id: 'fork:i:0:ai-0', seq: 1, role: 'assistant', text: 'Ön Yanıt' },
      ],
    };
    const turns = [prefixTurn, makeTurn('t1', 0, '1'), makeTurn('t2', 1, '2')];

    expect(sliceTurnsBeforeItem(turns, 'fork:i:0:ai-0')).toEqual([]);
    expect(sliceTurnsBeforeItem(turns, 'user-1').map((t) => t.id)).toEqual(['fork:t:0:t0']);
    expect(sliceTurnsBeforeItem(turns, 'ai-2').map((t) => t.id)).toEqual(['fork:t:0:t0', 't1']);
  });

  it('preserves all turns when targetItemId is missing or not found', () => {
    const turns = [makeTurn('t1', 0, '1'), makeTurn('t2', 1, '2')];
    expect(sliceTurnsBeforeItem(turns, 'missing-id').map((t) => t.id)).toEqual(['t1', 't2']);
    expect(sliceTurnsBeforeItem(turns, '').map((t) => t.id)).toEqual(['t1', 't2']);
  });
});

describe('extractTargetTurnInfo', () => {
  it('extracts turnsBefore and userPromptText for first turn', () => {
    const turns = [makeTurn('t1', 0, '1'), makeTurn('t2', 1, '2')];
    const info = extractTargetTurnInfo(turns, 'user-1');
    expect(info.turnsBefore).toEqual([]);
    expect(info.userPromptText).toBe('Soru 1');
  });

  it('extracts turnsBefore and userPromptText when targeting an assistant item in middle turn', () => {
    const turns = [makeTurn('t1', 0, '1'), makeTurn('t2', 1, '2'), makeTurn('t3', 2, '3')];
    const info = extractTargetTurnInfo(turns, 'ai-2');
    expect(info.turnsBefore.map((t) => t.id)).toEqual(['t1']);
    expect(info.userPromptText).toBe('Soru 2');
  });

  it('falls back to the preceding user prompt when target turn has only assistant items', () => {
    const turns: BranchTurnLike[] = [
      makeTurn('t1', 0, '1'),
      {
        id: 't2-user',
        seq: 1,
        items: [{ kind: 'message', id: 'user-only', role: 'user', text: 'Özel İstem' }],
      },
      {
        id: 't2-agent',
        seq: 2,
        items: [{ kind: 'message', id: 'ai-only', role: 'assistant', text: 'Ajan cevabı' }],
      },
    ];
    const info = extractTargetTurnInfo(turns, 'ai-only');
    expect(info.turnsBefore.map((t) => t.id)).toEqual(['t1', 't2-user']);
    expect(info.userPromptText).toBe('Özel İstem');
  });

  it('extracts userPromptText across nested children and prefix turns', () => {
    const prefixTurn: BranchTurnLike = {
      id: 'seg:0:t0',
      seq: -1_000_000,
      items: [
        { kind: 'message', id: 'seg:0:user-0', role: 'user', text: 'İlk İstem' },
        {
          kind: 'tool',
          id: 'seg:0:tool-0',
          children: [{ kind: 'execute', id: 'seg:0:exec-0' }],
        },
      ],
    };
    const turns = [prefixTurn, makeTurn('t1', 0, '1')];
    const info = extractTargetTurnInfo(turns, 'seg:0:exec-0');
    expect(info.turnsBefore).toEqual([]);
    expect(info.userPromptText).toBe('İlk İstem');
  });

  it('returns null userPromptText when targetItemId is not found', () => {
    const turns = [makeTurn('t1', 0, '1')];
    const info = extractTargetTurnInfo(turns, 'non-existent');
    expect(info.turnsBefore.map((t) => t.id)).toEqual(['t1']);
    expect(info.userPromptText).toBeNull();
  });
});

describe('branchConversationFromBeforeItem', () => {
  beforeEach(() => {
    loadHistoryMock.mockReset();
    createConversationMock.mockClear();
    openPaneMock.mockClear();
    closeTabMock.mockClear();
    setActiveGroupMock.mockClear();
    findSingleMountEntryMock.mockReset();
    findSingleMountEntryMock.mockReturnValue({ tabId: 'tab-old' });
  });

  it('branches before middle item with autoSendPromptText, injects hiddenContext, swaps tab in-place, and marks superseded', async () => {
    const turns = [makeTurn('t1', 0, '1'), makeTurn('t2', 1, '2')];
    loadHistoryMock.mockResolvedValueOnce({
      success: true,
      data: { turns, nextCursor: null },
    });

    const result = await branchConversationFromBeforeItem({
      projectId: 'proj-1',
      taskId: 'task-1',
      sourceConversationId: 'conv-src',
      targetItemId: 'user-2',
      visibleTurns: turns,
      autoSendPromptText: 'Düzenlenmiş Soru 2',
      effort: 'high',
      permissionMode: 'read-only',
    });

    expect(createConversationMock).toHaveBeenCalledTimes(1);
    expect(createConversationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: result.conversationId,
        projectId: 'proj-1',
        taskId: 'task-1',
        provider: 'claude',
        title: 'Ana Sohbet',
        modeId: 'read-only',
        effort: 'high',
        type: 'acp',
        initialQueue: [
          {
            text: 'Düzenlenmiş Soru 2',
            hiddenContext: expect.stringContaining('Soru 1'),
          },
        ],
      })
    );
    const callArg = createConversationMock.mock.calls[0]![0] as {
      initialQueue?: Array<{ hiddenContext?: string }>;
    };
    expect(callArg.initialQueue?.[0]?.hiddenContext).not.toContain('Soru 2');

    const cached = getCachedPrefixTurns(result.conversationId);
    expect(cached).toHaveLength(1);
    expect(cached?.[0]?.items.map((i) => i.id)).toEqual(['fork:i:0:user-1', 'fork:i:0:ai-1']);

    const record = getHandoffStore().get(result.conversationId);
    expect(record).toMatchObject({
      mode: 'fork',
      sourceConversationId: 'conv-src',
      sourceTitle: 'Ana Sohbet',
      sourceItemId: 'ai-1',
      contextDelivered: true,
      targetEffort: 'high',
    });
    expect(getHandoffStore().isSuperseded('conv-src')).toBe(true);
    expect(getHandoffStore().resolveLatest('conv-src')).toBe(result.conversationId);

    expect(openPaneMock).toHaveBeenCalledWith(
      'acp-chat',
      { conversationId: result.conversationId },
      { preview: false }
    );
    expect(closeTabMock).toHaveBeenCalledWith('tab-old');
  });

  it('branches cleanly for rewind without initialQueue, sets draftText and contextDelivered: false', async () => {
    const turns = [makeTurn('t1', 0, '1'), makeTurn('t2', 1, '2')];
    loadHistoryMock.mockResolvedValueOnce({
      success: true,
      data: { turns, nextCursor: null },
    });

    const result = await branchConversationFromBeforeItem({
      projectId: 'proj-1',
      taskId: 'task-1',
      sourceConversationId: 'conv-src',
      targetItemId: 'user-2',
      visibleTurns: turns,
      draftText: 'Taslak metin',
    });

    const callArg = createConversationMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.initialQueue).toBeUndefined();
    expect(consumePendingDraftText(result.conversationId)).toBe('Taslak metin');

    const record = getHandoffStore().get(result.conversationId);
    expect(record).toMatchObject({
      mode: 'fork',
      sourceConversationId: 'conv-src',
      contextDelivered: false,
    });
  });

  it('skips handoff record and hiddenContext when branching before the very first turn', async () => {
    const turns = [makeTurn('t1', 0, '1')];
    loadHistoryMock.mockResolvedValueOnce({
      success: true,
      data: { turns, nextCursor: null },
    });

    const result = await branchConversationFromBeforeItem({
      projectId: 'proj-1',
      taskId: 'task-1',
      sourceConversationId: 'conv-src',
      targetItemId: 'user-1',
      visibleTurns: turns,
      autoSendPromptText: 'İlk soru v2',
    });

    expect(createConversationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialQueue: [{ text: 'İlk soru v2' }],
      })
    );
    expect(getCachedPrefixTurns(result.conversationId)).toBeUndefined();
    expect(getHandoffStore().get(result.conversationId)).toBeUndefined();
  });

  it('opens in a new tab without closing old tab or marking superseded in new-tab mode', async () => {
    const turns = [makeTurn('t1', 0, '1'), makeTurn('t2', 1, '2')];
    loadHistoryMock.mockResolvedValueOnce({
      success: true,
      data: { turns, nextCursor: null },
    });
    const prevSupersededCount = getHandoffStore().isSuperseded('conv-new-tab-src');
    expect(prevSupersededCount).toBe(false);

    const result = await branchConversationFromBeforeItem({
      projectId: 'proj-1',
      taskId: 'task-1',
      sourceConversationId: 'conv-src',
      targetItemId: 'ai-2',
      visibleTurns: turns,
      mode: 'new-tab',
    });

    expect(openPaneMock).toHaveBeenCalledWith(
      'acp-chat',
      { conversationId: result.conversationId },
      { preview: false }
    );
    expect(closeTabMock).not.toHaveBeenCalled();
  });
});
