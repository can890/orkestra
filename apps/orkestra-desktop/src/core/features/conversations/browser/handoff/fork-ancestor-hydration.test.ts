import type { TranscriptTurn } from '@orkestra/chat-ui';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_ANCESTOR_DEPTH,
  resolveForkAncestorPrefixTurns,
  type LoadHistoryPageFn,
} from './fork-ancestor-hydration';
import type { HandoffRecord } from './handoff-store';

function makeTurn(id: string, seq: number, label: string): TranscriptTurn {
  return {
    id,
    seq,
    initiator: 'user',
    items: [
      { kind: 'message', id: `u-${label}`, seq: 0, role: 'user', text: `Soru ${label}` },
      { kind: 'message', id: `a-${label}`, seq: 1, role: 'assistant', text: `Yanıt ${label}` },
    ],
  };
}

function collectAllItemIds(
  turns: Awaited<ReturnType<typeof resolveForkAncestorPrefixTurns>>
): string[] {
  return turns.flatMap((turn) => turn.items.map((item) => item.id));
}

function assertMonotonicNegativeSeqs(
  turns: Awaited<ReturnType<typeof resolveForkAncestorPrefixTurns>>
): void {
  expect(turns.length).toBeGreaterThan(0);
  expect(turns[0]?.seq).toBe(-1_000_000);
  for (let i = 0; i < turns.length; i += 1) {
    expect(turns[i]!.seq).toBeLessThan(0);
    if (i > 0) {
      expect(turns[i]!.seq).toBeGreaterThan(turns[i - 1]!.seq);
    }
  }
}

describe('resolveForkAncestorPrefixTurns', () => {
  it('hydrates a 1-level fork and slices inclusively at sourceItemId', async () => {
    const records = new Map<string, HandoffRecord>([
      [
        'conv-B',
        {
          version: 1,
          mode: 'fork',
          sourceConversationId: 'conv-A',
          sourceTitle: 'A',
          sourceItemId: 'a-A1',
          context: 'ctx',
          createdAt: 100,
        },
      ],
    ]);

    const loadHistoryPage = vi.fn<LoadHistoryPageFn>(async (convId) => {
      if (convId === 'conv-A') {
        return {
          success: true,
          data: { turns: [makeTurn('t1', 0, 'A1'), makeTurn('t2', 1, 'A2')], nextCursor: null },
        };
      }
      return { success: true, data: { turns: [], nextCursor: null } };
    });

    const result = await resolveForkAncestorPrefixTurns('conv-B', {
      getRecord: (id) => records.get(id),
      loadHistoryPage,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('fork:t:0:t1');
    expect(result[0]!.items.map((i) => i.id)).toEqual(['fork:i:0:u-A1', 'fork:i:0:a-A1']);
    assertMonotonicNegativeSeqs(result);
  });

  it('hydrates a 3-level fork-of-fork (A -> fork B -> fork C) without double-rewriting IDs or colliding', async () => {
    const records = new Map<string, HandoffRecord>([
      [
        'conv-B',
        {
          version: 1,
          mode: 'fork',
          sourceConversationId: 'conv-A',
          sourceTitle: 'A',
          sourceItemId: 'a-A1',
          context: 'ctx-b',
          createdAt: 100,
        },
      ],
      [
        'conv-C',
        {
          version: 1,
          mode: 'fork',
          sourceConversationId: 'conv-B',
          sourceTitle: 'B',
          sourceItemId: 'a-B1',
          context: 'ctx-c',
          createdAt: 200,
        },
      ],
    ]);

    // Notice both conv-A and conv-B reuse identical raw turn/item ids ('t1', 'u-shared')!
    const history = new Map<string, TranscriptTurn[]>([
      ['conv-A', [makeTurn('t1', 0, 'A1'), makeTurn('t2', 1, 'A2')]],
      [
        'conv-B',
        [
          {
            id: 't1',
            seq: 0,
            initiator: 'user',
            items: [
              { kind: 'message', id: 'u-shared', seq: 0, role: 'user', text: 'B1 soru' },
              { kind: 'message', id: 'a-B1', seq: 1, role: 'assistant', text: 'B1 yanıt' },
            ],
          },
          makeTurn('t2', 1, 'B2'),
        ],
      ],
    ]);

    const loadHistoryPage = vi.fn<LoadHistoryPageFn>(async (convId) => ({
      success: true,
      data: { turns: history.get(convId) ?? [], nextCursor: null },
    }));

    const result = await resolveForkAncestorPrefixTurns('conv-C', {
      getRecord: (id) => records.get(id),
      loadHistoryPage,
    });

    expect(result).toHaveLength(2);
    // Ancestor turn from A keeps single fork prefix (not fork:t:0:fork:t:0:...)
    expect(result[0]!.id).toBe('fork:t:0:t1');
    expect(result[0]!.items.map((i) => i.id)).toEqual(['fork:i:0:u-A1', 'fork:i:0:a-A1']);
    // Turn from B gets distinct slot index and never collides with conv-A's 't1'
    expect(result[1]!.id).toBe('fork:t:1:t1');
    expect(result[1]!.items.map((i) => i.id)).toEqual(['fork:i:1:u-shared', 'fork:i:1:a-B1']);

    const turnIds = result.map((t) => t.id);
    const itemIds = collectAllItemIds(result);
    expect(new Set(turnIds).size).toBe(turnIds.length);
    expect(new Set(itemIds).size).toBe(itemIds.length);
    assertMonotonicNegativeSeqs(result);
  });

  it('hydrates fork-of-inline-handoff preserving handoff-divider items and segment history', async () => {
    const records = new Map<string, HandoffRecord>([
      [
        'conv-B',
        {
          version: 1,
          mode: 'inline-handoff',
          sourceConversationId: 'conv-A',
          sourceTitle: 'A',
          context: 'inline-ctx',
          createdAt: 100,
          chain: [
            {
              conversationId: 'conv-A',
              fromProviderId: 'codex',
              fromModelLabel: 'GPT-6.2',
              toProviderId: 'claude',
              toModelLabel: 'Opus',
              createdAt: 100,
            },
          ],
        },
      ],
      [
        'conv-C',
        {
          version: 1,
          mode: 'fork',
          sourceConversationId: 'conv-B',
          sourceTitle: 'B',
          sourceItemId: 'a-B1',
          context: 'fork-ctx',
          createdAt: 200,
        },
      ],
    ]);

    const history = new Map<string, TranscriptTurn[]>([
      ['conv-A', [makeTurn('tA', 0, 'A1')]],
      ['conv-B', [makeTurn('tB1', 0, 'B1'), makeTurn('tB2', 1, 'B2')]],
    ]);

    const loadHistoryPage = vi.fn<LoadHistoryPageFn>(async (convId) => ({
      success: true,
      data: { turns: history.get(convId) ?? [], nextCursor: null },
    }));

    const result = await resolveForkAncestorPrefixTurns('conv-C', {
      getRecord: (id) => records.get(id),
      loadHistoryPage,
    });

    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe('seg:0:tA');
    expect(result[1]!.id).toBe('handoff-divider:0:conv-A');
    expect(result[1]!.items[0]).toMatchObject({
      kind: 'handoff-divider',
      fromProviderId: 'codex',
      toProviderId: 'claude',
    });
    expect(result[2]!.id).toBe('fork:t:2:tB1');
    expect(result[2]!.items.map((i) => i.id)).toEqual(['fork:i:2:u-B1', 'fork:i:2:a-B1']);

    const turnIds = result.map((t) => t.id);
    const itemIds = collectAllItemIds(result);
    expect(new Set(turnIds).size).toBe(turnIds.length);
    expect(new Set(itemIds).size).toBe(itemIds.length);
    assertMonotonicNegativeSeqs(result);
  });

  it('protects against cycles (A <-> B) and deep chains exceeding max depth', async () => {
    const cyclicRecords = new Map<string, HandoffRecord>([
      [
        'conv-A',
        {
          version: 1,
          mode: 'fork',
          sourceConversationId: 'conv-B',
          sourceTitle: 'B',
          context: 'a',
          createdAt: 1,
        },
      ],
      [
        'conv-B',
        {
          version: 1,
          mode: 'fork',
          sourceConversationId: 'conv-A',
          sourceTitle: 'A',
          context: 'b',
          createdAt: 2,
        },
      ],
    ]);

    const loadHistoryPage = vi.fn<LoadHistoryPageFn>(async (convId) => ({
      success: true,
      data: { turns: [makeTurn(`t-${convId}`, 0, convId)], nextCursor: null },
    }));

    const cyclicResult = await resolveForkAncestorPrefixTurns('conv-A', {
      getRecord: (id) => cyclicRecords.get(id),
      loadHistoryPage,
    });
    expect(cyclicResult).toHaveLength(1);
    expect(loadHistoryPage).toHaveBeenCalledTimes(1);
    expect(loadHistoryPage).toHaveBeenCalledWith('conv-B', undefined);

    // Depth limit check (> MAX_ANCESTOR_DEPTH)
    const deepRecords = new Map<string, HandoffRecord>();
    for (let i = 1; i <= MAX_ANCESTOR_DEPTH + 5; i += 1) {
      deepRecords.set(`c-${i}`, {
        version: 1,
        mode: 'fork',
        sourceConversationId: `c-${i - 1}`,
        sourceTitle: `c-${i - 1}`,
        context: 'ctx',
        createdAt: i,
      });
    }
    const deepLoader = vi.fn<LoadHistoryPageFn>(async (convId) => ({
      success: true,
      data: { turns: [makeTurn(`t-${convId}`, 0, convId)], nextCursor: null },
    }));

    const deepResult = await resolveForkAncestorPrefixTurns(`c-${MAX_ANCESTOR_DEPTH + 5}`, {
      getRecord: (id) => deepRecords.get(id),
      loadHistoryPage: deepLoader,
    });
    expect(deepResult.length).toBeLessThanOrEqual(MAX_ANCESTOR_DEPTH);
    assertMonotonicNegativeSeqs(deepResult);
  });
});
