import type { TranscriptTurn } from '@orkestra/chat-ui';
import { describe, expect, it, vi } from 'vitest';
import { HandoffStore } from './handoff-store';
import {
  buildInlineHandoffPrefixTurns,
  hydrateChainPrefixTurns,
} from './switch-provider-in-place';

function makeTurn(id: string, seq: number, text: string): TranscriptTurn {
  return {
    id,
    seq,
    initiator: 'user',
    items: [
      {
        kind: 'message',
        id: `msg-${id}`,
        seq: 0,
        role: 'user',
        text,
      },
      {
        kind: 'message',
        id: `reply-${id}`,
        seq: 1,
        role: 'assistant',
        text: `Yanıt: ${text}`,
      },
    ],
  };
}

describe('buildInlineHandoffPrefixTurns', () => {
  it('assigns unique prefixed ids, negative increasing seqs, and inserts handoff-divider turns', () => {
    const result = buildInlineHandoffPrefixTurns([
      {
        segmentIndex: 0,
        turns: [makeTurn('t2', 2, 'ikinci'), makeTurn('t1', 1, 'birinci')],
        divider: {
          conversationId: 'c1',
          fromProviderId: 'codex',
          fromModelLabel: '6 Luna',
          toProviderId: 'claude',
          toModelLabel: 'Opus 5.5',
          createdAt: 100,
        },
      },
      {
        segmentIndex: 1,
        turns: [makeTurn('t1', 1, 'devam')],
        divider: {
          conversationId: 'c2',
          fromProviderId: 'claude',
          fromModelLabel: 'Opus 5.5',
          toProviderId: 'antigravity',
          toModelLabel: 'Gemini 4 Neon',
          createdAt: 200,
        },
      },
    ]);

    expect(result.map((t) => t.id)).toEqual([
      'seg:0:t1',
      'seg:0:t2',
      'handoff-divider:0:c1',
      'seg:1:t1',
      'handoff-divider:1:c2',
    ]);
    // Strict monotonic negative seqs
    for (let i = 0; i < result.length; i += 1) {
      expect(result[i]!.seq).toBeLessThan(0);
      if (i > 0) expect(result[i]!.seq).toBeGreaterThan(result[i - 1]!.seq);
    }
    expect(result[2]!.items[0]).toMatchObject({
      kind: 'handoff-divider',
      fromProviderId: 'codex',
      fromLabel: '6 Luna',
      toProviderId: 'claude',
      toLabel: 'Opus 5.5',
    });
    expect(result[3]!.items[0]).toMatchObject({ id: 'seg:1:msg-t1' });
  });

  it('reconstructs cold chain history via hydrateChainPrefixTurns', async () => {
    const loader = vi.fn(async (convId: string) => ({
      success: true as const,
      data: {
        turns: [makeTurn('t1', 0, `selam-${convId}`)],
        nextCursor: null,
      },
    }));
    const result = await hydrateChainPrefixTurns(
      [
        {
          conversationId: 'c1',
          fromProviderId: 'codex',
          fromModelLabel: 'GPT-6.2 Sol',
          toProviderId: 'claude',
          toModelLabel: 'Opus 5.5',
          createdAt: 10,
        },
      ],
      loader
    );

    expect(loader).toHaveBeenCalledWith('c1', undefined);
    expect(result).toHaveLength(2);
    expect(result[1]!.items[0]).toMatchObject({ kind: 'handoff-divider' });
  });
});

describe('HandoffStore superseded chain tracking', () => {
  it('tracks superseded conversations and resolves the latest id safely', () => {
    const store = new HandoffStore(null, null);
    store.markSuperseded('c1', 'c2');
    store.markSuperseded('c2', 'c3');

    expect(store.isSuperseded('c1')).toBe(true);
    expect(store.isSuperseded('c2')).toBe(true);
    expect(store.isSuperseded('c3')).toBe(false);
    expect(store.resolveLatest('c1')).toBe('c3');
  });
});
