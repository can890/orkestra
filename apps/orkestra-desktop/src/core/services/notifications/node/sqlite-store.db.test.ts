import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppNotification } from '../api';
import { SqliteNotificationStore } from './sqlite-store';

const notification: AppNotification = {
  id: 'n-1',
  kind: 'agent-attention',
  groupKey: 'conversation:conv-1',
  title: 'Codex - Task',
  body: 'Your agent is waiting for input',
  target: { kind: 'task', projectId: 'project-1', taskId: 'task-1', conversationId: 'conv-1' },
  source: {
    kind: 'conversation',
    projectId: 'project-1',
    taskId: 'task-1',
    conversationId: 'conv-1',
  },
  sound: 'needs_attention',
  count: 1,
  createdAt: 1_000,
  readAt: null,
};

describe('SqliteNotificationStore', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('round-trips notifications and read state', async () => {
    fixture = await openFixture('empty');
    const store = new SqliteNotificationStore(fixture.db);

    expect(await store.insert(notification)).toEqual({ success: true, data: undefined });
    expect(await store.loadRecent({ since: 0, maxRows: 10 })).toEqual([notification]);

    expect(await store.markRead(['n-1'], 2_000)).toEqual({ success: true, data: undefined });
    expect(await store.loadRecent({ since: 0, maxRows: 10 })).toEqual([
      { ...notification, readAt: 2_000 },
    ]);

    expect(await store.remove(['n-1'])).toEqual({ success: true, data: undefined });
    expect(await store.loadRecent({ since: 0, maxRows: 10 })).toEqual([]);
  });

  it('prunes expired rows and keeps only the newest maxRows', async () => {
    fixture = await openFixture('empty');
    const store = new SqliteNotificationStore(fixture.db);
    for (const [id, createdAt] of [
      ['expired', 500],
      ['oldest', 1_000],
      ['middle', 2_000],
      ['newer', 3_000],
      ['newest', 4_000],
    ] as const) {
      await store.insert({ ...notification, id, createdAt });
    }

    expect(await store.prune({ olderThan: 900, maxRows: 2 })).toEqual({
      success: true,
      data: undefined,
    });
    const remaining = await store.loadRecent({ since: 0, maxRows: 10 });
    expect(remaining.map((row) => row.id)).toEqual(['newer', 'newest']);
  });

  it('keeps every unexpired row when there are fewer than maxRows', async () => {
    fixture = await openFixture('empty');
    const store = new SqliteNotificationStore(fixture.db);
    await store.insert(notification);
    await store.insert({ ...notification, id: 'n-2', createdAt: 2_000 });

    expect(await store.prune({ olderThan: 0, maxRows: 10 })).toEqual({
      success: true,
      data: undefined,
    });
    const remaining = await store.loadRecent({ since: 0, maxRows: 10 });
    expect(remaining.map((row) => row.id)).toEqual(['n-1', 'n-2']);
  });
});
