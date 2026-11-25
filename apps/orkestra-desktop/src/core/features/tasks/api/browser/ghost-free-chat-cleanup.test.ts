import { describe, expect, it, vi } from 'vitest';
import { scheduleGhostFreeChatCleanup } from './ghost-free-chat-cleanup';

type Status = 'already-done' | 'deferred' | 'done';

function client(statuses: Status[]) {
  const calls: string[][] = [];
  return {
    calls,
    cleanupGhostFreeChats: vi.fn(async ({ openTaskIds }: { openTaskIds: string[] }) => {
      calls.push(openTaskIds);
      const status = statuses.shift() ?? 'done';
      return { status, removedCount: 0, completed: status !== 'deferred' };
    }),
  };
}

describe('scheduleGhostFreeChatCleanup', () => {
  it('waits, then sends the currently open task ids on every attempt', async () => {
    const fake = client(['deferred', 'done']);
    const waits: number[] = [];
    let open = ['task-a'];
    await scheduleGhostFreeChatCleanup({
      getClient: async () => fake,
      openTaskIds: () => open,
      wait: async (ms) => {
        waits.push(ms);
        open = ['task-b'];
      },
      initialDelayMs: 5,
      retryDelayMs: 7,
    });
    expect(waits).toEqual([5, 7]);
    expect(fake.calls).toEqual([['task-b'], ['task-b']]);
  });

  it('stops retrying after the attempt limit', async () => {
    const fake = client(['deferred', 'deferred', 'deferred', 'deferred']);
    await scheduleGhostFreeChatCleanup({
      getClient: async () => fake,
      openTaskIds: () => [],
      wait: async () => {},
      maxAttempts: 3,
    });
    expect(fake.cleanupGhostFreeChats).toHaveBeenCalledTimes(3);
  });

  it('reports errors and does not retry', async () => {
    const onError = vi.fn();
    await scheduleGhostFreeChatCleanup({
      getClient: async () => {
        throw new Error('wire down');
      },
      openTaskIds: () => [],
      wait: async () => {},
      onError,
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
