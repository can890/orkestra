import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConversationRegistry } from '@core/features/conversations/api/node/registry';
import { registryLastUsedAt } from './context-handoff-transcript-retention';

describe('registryLastUsedAt', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
  });

  afterEach(() => {
    fixture.close();
  });

  function seed(id: string): void {
    createConversationRegistry(fixture.db).register({
      id,
      projectId: null,
      taskId: null,
      title: `Conversation ${id}`,
      provider: 'claude',
      type: 'acp',
      location: 'local',
      sshConnectionId: null,
    });
  }

  it('halef sohbeti duruyorsa en son kullanım zamanını, durmuyorsa hiçbir şey döndürmez', async () => {
    seed('conv-live');
    seed('conv-untracked');
    fixture.sqlite
      .prepare(
        `UPDATE conversations SET created_at = ?, updated_at = ?, last_session_activity_at = ? WHERE id = ?`
      )
      .run('2026-10-01 10:00:00', '2026-11-01 10:00:00', '2026-11-20T08:00:00.000Z', 'conv-live');
    fixture.sqlite
      .prepare(`UPDATE conversations SET untracked_at = ? WHERE id = ?`)
      .run('2026-11-02T00:00:00.000Z', 'conv-untracked');

    const usage = await registryLastUsedAt(fixture.db, [
      'conv-live',
      'conv-untracked',
      'conv-gone',
    ]);

    expect([...usage.keys()]).toEqual(['conv-live']);
    expect(usage.get('conv-live')).toBe(Date.UTC(2026, 10, 20, 8));
  });
});
