import type { TranscriptTurn } from '@orkestra/chat-ui';
import { describe, expect, it } from 'vitest';
import { buildEarlierSessionPrefixTurns } from './earlier-session-turns';

const turn = (id: string, seq: number, text: string): TranscriptTurn =>
  ({
    id,
    seq,
    initiator: 'user',
    items: [
      { kind: 'message', id: `${id}:m`, seq: 0, role: 'user', text },
      {
        kind: 'tool-group',
        id: `${id}:g`,
        seq: 1,
        label: 'Ran 1 command',
        groupKind: 'tool-run',
        status: 'done',
        children: [
          {
            kind: 'execute-tool-call',
            id: `${id}:t`,
            seq: 2,
            toolCallId: 'c1',
            title: 'ls',
            status: 'done',
          },
        ],
      },
    ],
  }) as unknown as TranscriptTurn;

describe('buildEarlierSessionPrefixTurns', () => {
  it('keeps the turns in order with ids and seqs that cannot collide with the new session', () => {
    const prefix = buildEarlierSessionPrefixTurns([
      turn('conv:t1', 1, 'b'),
      turn('conv:t0', 0, 'a'),
    ]);
    expect(prefix.map((t) => [t.id, t.seq])).toEqual([
      ['earlier-session:conv:t0', -2_000_000],
      ['earlier-session:conv:t1', -1_999_999],
    ]);
    expect(prefix[0]!.items.map((item) => item.id)).toEqual([
      'earlier-session:conv:t0:m',
      'earlier-session:conv:t0:g',
    ]);
    const group = prefix[0]!.items[1] as unknown as { children: Array<{ id: string }> };
    expect(group.children[0]!.id).toBe('earlier-session:conv:t0:t');
    expect((prefix[0]!.items[0] as unknown as { text: string }).text).toBe('a');
  });
});
