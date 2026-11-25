import { describe, expect, it } from 'vitest';
import {
  dropFreeChat,
  moveFreeChat,
  moveFreeChatBy,
  orderFreeChats,
  timestampMs,
} from './free-chat-order';

const item = (id: string, createdAt: string | null) => ({ id, createdAt });

describe('timestampMs', () => {
  it('parses SQLite CURRENT_TIMESTAMP values as UTC, like ISO strings', () => {
    expect(timestampMs('2026-11-25 10:43:56')).toBe(Date.parse('2026-11-25T10:43:56Z'));
    expect(timestampMs('2026-11-25T10:43:56.186Z')).toBe(Date.parse('2026-11-25T10:43:56.186Z'));
  });

  it('returns 0 for missing or unparseable values', () => {
    expect(timestampMs(undefined)).toBe(0);
    expect(timestampMs(null)).toBe(0);
    expect(timestampMs('')).toBe(0);
    expect(timestampMs('not a date')).toBe(0);
  });
});

describe('orderFreeChats', () => {
  it('sorts unplaced chats newest first with a stable id tie-break', () => {
    const ordered = orderFreeChats(
      [
        item('b', '2026-11-24T10:00:00.000Z'),
        item('a', '2026-11-24T10:00:00.000Z'),
        item('new', '2026-11-25 09:00:00'),
        item('unknown-time', null),
      ],
      undefined
    );
    expect(ordered.map((i) => i.id)).toEqual(['new', 'a', 'b', 'unknown-time']);
  });

  it('inserts chats missing from the manual order at the top and keeps placed rows in place', () => {
    const ordered = orderFreeChats(
      [
        item('x', '2026-11-20T00:00:00.000Z'),
        item('y', '2026-11-21T00:00:00.000Z'),
        item('newer', '2026-11-25T00:00:00.000Z'),
        item('new', '2026-11-24T00:00:00.000Z'),
      ],
      ['x', 'y']
    );
    expect(ordered.map((i) => i.id)).toEqual(['newer', 'new', 'x', 'y']);
  });

  it('skips removed and duplicate ids from the stored order', () => {
    const ordered = orderFreeChats(
      [item('a', '2026-11-20T00:00:00.000Z'), item('b', '2026-11-21T00:00:00.000Z')],
      ['gone', 'b', 'b', 'a']
    );
    expect(ordered.map((i) => i.id)).toEqual(['b', 'a']);
  });
});

describe('moveFreeChat / moveFreeChatBy / dropFreeChat', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('moves to an index, clamping to the list bounds', () => {
    expect(moveFreeChat(ids, 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveFreeChat(ids, 'a', 99)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveFreeChat(ids, 'b', 1)).toBeNull();
    expect(moveFreeChat(ids, 'missing', 0)).toBeNull();
  });

  it('steps one row up or down and stops at the edges', () => {
    expect(moveFreeChatBy(ids, 'b', -1)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveFreeChatBy(ids, 'b', 1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveFreeChatBy(ids, 'a', -1)).toBeNull();
    expect(moveFreeChatBy(ids, 'd', 1)).toBeNull();
    expect(moveFreeChatBy(ids, 'missing', 1)).toBeNull();
  });

  it('drops above or below the hovered row', () => {
    expect(dropFreeChat(ids, 'a', 'c', true)).toEqual(['b', 'a', 'c', 'd']);
    expect(dropFreeChat(ids, 'a', 'c', false)).toEqual(['b', 'c', 'a', 'd']);
    expect(dropFreeChat(ids, 'd', 'a', true)).toEqual(['d', 'a', 'b', 'c']);
    expect(dropFreeChat(ids, 'a', 'b', true)).toBeNull();
    expect(dropFreeChat(ids, 'a', 'a', true)).toBeNull();
    expect(dropFreeChat(ids, 'a', 'missing', true)).toBeNull();
  });
});
