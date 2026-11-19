import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { AcpTranscriptParser } from './parser';

function chunk(kind: 'user' | 'agent', messageId: string, text: string): SessionUpdate {
  return {
    sessionUpdate: kind === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
    sessionId: 's',
    messageId,
    content: { type: 'text', text },
  } as unknown as SessionUpdate;
}

const side = (
  role: 'user' | 'assistant',
  text: string,
  status: 'pending' | 'running' | 'done' | 'error' = 'running'
) => ({ sideId: 'one', role, text, question: 'son durum?', status });

function texts(parser: AcpTranscriptParser): string[] {
  return [...parser.history, ...(parser.activeTurn ? [parser.activeTurn] : [])]
    .flatMap((turn) => turn.items)
    .map((item) =>
      item.kind === 'message' ? `${item.role}${item.side ? '*' : ''}:${item.text}` : item.kind
    );
}

describe('side exchange in the transcript', () => {
  it('lands inside the active turn, ends the open segment and leaves the main stream intact', () => {
    const parser = new AcpTranscriptParser({ conversationId: 'c' });
    parser.push(chunk('user', 'u1', 'işe başla'));
    parser.push(chunk('agent', 'a1', 'adım 1'));
    const turnId = parser.activeTurn?.id;

    parser.pushSideMessage(side('user', 'son durum?', 'pending'));
    parser.pushSideMessage(side('assistant', 'Hazırlanıyor…'));
    parser.push(chunk('agent', 'a2', ' adım 2'));

    expect(parser.activeTurn?.id).toBe(turnId);
    expect(texts(parser)).toEqual([
      'user:işe başla',
      'assistant:adım 1',
      'user*:son durum?',
      'assistant*:Hazırlanıyor…',
      'assistant: adım 2',
    ]);
  });

  it('updates the answer in place while it streams, once and in order', () => {
    const parser = new AcpTranscriptParser({ conversationId: 'c' });
    parser.push(chunk('user', 'u1', 'işe başla'));
    parser.pushSideMessage(side('user', 'son durum?', 'pending'));
    parser.pushSideMessage(side('assistant', ''));
    parser.pushSideMessage(side('assistant', 'Üç dosya'));
    parser.pushSideMessage(side('assistant', 'Üç dosya düzenlendi.', 'done'));

    const items = parser.activeTurn?.items ?? [];
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.seq)).toEqual([0, 1, 2]);
    expect(items[2]).toMatchObject({
      text: 'Üç dosya düzenlendi.',
      side: { question: 'son durum?', status: 'done' },
    });
  });

  it('amends the committed turn after the main turn settled and bumps the history revision', () => {
    const parser = new AcpTranscriptParser({ conversationId: 'c' });
    parser.push(chunk('user', 'u1', 'işe başla'));
    parser.pushSideMessage(side('user', 'son durum?', 'pending'));
    parser.pushSideMessage(side('assistant', 'kısmi'));
    parser.settleTurn({ kind: 'done', reason: 'end_turn' });
    const revision = parser.historyRevision;

    parser.pushSideMessage(side('assistant', 'kısmi ve tamamı', 'done'));

    expect(parser.activeTurn).toBeNull();
    expect(texts(parser)).toContain('assistant*:kısmi ve tamamı');
    expect(parser.historyRevision).toBe(revision + 1);
    expect(parser.history).toHaveLength(1);
  });

  it('is dropped when there is no turn at all', () => {
    const parser = new AcpTranscriptParser({ conversationId: 'c' });
    parser.pushSideMessage(side('user', 'x'));
    expect(parser.history).toEqual([]);
    expect(parser.activeTurn).toBeNull();
  });
});
