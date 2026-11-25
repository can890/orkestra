import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConversationRegistry } from '@core/features/conversations/api/node/registry';
import { workspaceRegistryTable as workspaces } from '@core/features/workspaces/api/node/registry';
import { FREE_CHAT_PROJECT_ID } from '@core/primitives/projects/api';
import { tasks, terminals } from '@core/services/app-db/node/schema';
import type { MementosRuntimeClient } from '@core/services/runtime-broker/api/clients';
import { deleteTask, type TaskDeletionDependencies } from './deleteTask';
import {
  GHOST_FREE_CHAT_CLEANUP_VERSION,
  loadGhostFreeChatCandidates,
  runGhostFreeChatCleanup,
  type GhostFreeChatCleanupDependencies,
} from './ghost-free-chat-cleanup';

const NOW = Date.parse('2026-11-25T16:00:00.000Z');
const OLD = '2026-11-25T08:57:42.393Z';

describe('ghost free chat cleanup (db)', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    await fixture.db.insert(workspaces).values({
      id: 'free-ws',
      type: 'local',
      kind: 'directory',
      location: 'local',
      path: '/Users/me/.local/share/orkestra/free-chats',
    });
    fixture.sqlite
      .prepare(
        `INSERT INTO projects (id, name, repository_workspace_id) VALUES (?, 'Sohbetler', 'free-ws')`
      )
      .run(FREE_CHAT_PROJECT_ID);
  });

  afterEach(() => {
    fixture.close();
  });

  async function seedTask(id: string, name: string, createdAt = OLD): Promise<void> {
    await fixture.db.insert(tasks).values({
      id,
      projectId: FREE_CHAT_PROJECT_ID,
      name,
      status: 'in-progress',
      workspaceId: 'free-ws',
      createdAt,
    });
  }

  function seedConversation(id: string, taskId: string, options: { tombstone?: boolean } = {}) {
    const registry = createConversationRegistry(fixture.db);
    registry.adopt({
      id,
      title: 'Claude (1)',
      provider: 'claude',
      type: 'acp',
      location: 'local',
      workspacePath: '/Users/me/.local/share/orkestra/free-chats',
      lastObservedAt: OLD,
      observedStatus: 'present',
    });
    registry.annotate(id, { taskId, projectId: FREE_CHAT_PROJECT_ID });
    if (options.tombstone) {
      fixture.sqlite
        .prepare(`UPDATE conversations SET deletion_tombstone = ? WHERE id = ?`)
        .run(JSON.stringify({ version: '1', createdAt: 1 }), id);
    }
  }

  function taskDeletionDependencies(): TaskDeletionDependencies {
    return {
      db: fixture.db,
      runtimes: { client: vi.fn() } as unknown as TaskDeletionDependencies['runtimes'],
      sessionCleanup: {
        resolve: vi.fn(async () => ({
          acpConversationIds: [],
          tuiConversationIds: [],
          terminalSessionIds: [],
          tmuxSessionIdentities: [],
        })),
        killAcp: vi.fn(async () => {}),
        killTerminals: vi.fn(async () => {}),
      },
      getMementosRuntimeClient: async () =>
        ({
          deleteBySubject: vi.fn(async () => ({ success: true, data: { deleted: 0 } })),
        }) as unknown as MementosRuntimeClient,
      telemetry: { capture: vi.fn() },
      evictFileSearchRoot: vi.fn(),
    };
  }

  function dependencies(overrides: Partial<GhostFreeChatCleanupDependencies> = {}) {
    let stored: number | null = null;
    const deletion = taskDeletionDependencies();
    const deps: GhostFreeChatCleanupDependencies = {
      db: fixture.db,
      deleteTask: vi.fn(async (_projectId: string, taskId: string) => {
        const result = await deleteTask(deletion, {
          taskId,
          deleteConversations: true,
          deleteWorktree: false,
        });
        if (!result.success) throw new Error(result.error.message);
      }),
      readCompletedVersion: async () => stored,
      writeCompletedVersion: vi.fn(async (version: number) => {
        stored = version;
      }),
      builtInProviderIds: () => ['claude', 'antigravity'],
      waitForLocalSync: async () => true,
      hasPendingRegistrations: () => false,
      isHostSynced: () => true,
      logger: { info: vi.fn(), warn: vi.fn() },
      now: () => NOW,
      ...overrides,
    };
    return deps;
  }

  function remainingTaskIds(): string[] {
    return fixture.db
      .select({ id: tasks.id })
      .from(tasks)
      .all()
      .map((row) => row.id)
      .sort();
  }

  it('counts every conversation row (including tombstoned) and terminal per task', async () => {
    await seedTask('with-tombstoned', 'Claude (1)');
    seedConversation('conv-dead', 'with-tombstoned', { tombstone: true });
    await seedTask('with-terminal', 'Claude (1)');
    await fixture.db.insert(terminals).values({
      id: 'term-1',
      projectId: FREE_CHAT_PROJECT_ID,
      taskId: 'with-terminal',
      name: 'Terminal',
    });
    const byId = new Map(loadGhostFreeChatCandidates(fixture.db).map((c) => [c.id, c]));
    expect(byId.get('with-tombstoned')?.conversationCount).toBe(1);
    expect(byId.get('with-terminal')?.terminalCount).toBe(1);
    expect(byId.get('with-terminal')?.host).toEqual({ location: 'local', sshConnectionId: null });
  });

  it('removes only ghosts through the task deletion path and records completion', async () => {
    await seedTask('ghost-claude', 'Claude (1)');
    await seedTask('ghost-antigravity', 'Antigravity (1)', '2026-11-25 10:44:02');
    await seedTask('real-claude', 'Claude (1)');
    seedConversation('conv-real', 'real-claude');
    await seedTask('tombstoned-only', 'Claude (2)');
    seedConversation('conv-dead', 'tombstoned-only', { tombstone: true });
    await seedTask('user-named', 'Kedi görseli');
    await seedTask('fresh', 'Claude (1)', new Date(NOW - 60_000).toISOString());

    const deps = dependencies();
    const result = await runGhostFreeChatCleanup(deps, { openTaskIds: [] });

    expect(result).toMatchObject({ status: 'done', failed: [], held: [], completed: true });
    expect(result.status === 'done' && result.removed.map((r) => r.id).sort()).toEqual([
      'ghost-antigravity',
      'ghost-claude',
    ]);
    expect(remainingTaskIds()).toEqual(['fresh', 'real-claude', 'tombstoned-only', 'user-named']);
    expect(deps.writeCompletedVersion).toHaveBeenCalledWith(GHOST_FREE_CHAT_CLEANUP_VERSION);

    // Bayrak yazıldıktan sonra tekrar çalışmaz.
    await seedTask('later-ghost', 'Claude (3)');
    expect(await runGhostFreeChatCleanup(deps, { openTaskIds: [] })).toEqual({
      status: 'already-done',
    });
    expect(remainingTaskIds()).toContain('later-ghost');
  });

  it('holds the open task and does not record completion', async () => {
    await seedTask('ghost-open', 'Claude (1)');
    await seedTask('ghost-closed', 'Claude (2)');
    const deps = dependencies();
    const result = await runGhostFreeChatCleanup(deps, { openTaskIds: ['ghost-open'] });
    expect(result).toMatchObject({ status: 'done', held: ['ghost-open'], completed: false });
    expect(remainingTaskIds()).toEqual(['ghost-open']);
    expect(deps.writeCompletedVersion).not.toHaveBeenCalled();
  });

  it('defers while local sync has not settled or a registration is pending', async () => {
    await seedTask('ghost', 'Claude (1)');
    expect(
      await runGhostFreeChatCleanup(dependencies({ waitForLocalSync: async () => false }), {
        openTaskIds: [],
      })
    ).toEqual({ status: 'deferred', reason: 'local-sync-pending' });
    expect(
      await runGhostFreeChatCleanup(dependencies({ hasPendingRegistrations: () => true }), {
        openTaskIds: [],
      })
    ).toEqual({ status: 'deferred', reason: 'registration-pending' });
    expect(remainingTaskIds()).toEqual(['ghost']);
  });

  it('re-checks right before deleting: a conversation linked meanwhile saves the task', async () => {
    await seedTask('ghost', 'Claude (1)');
    let checks = 0;
    const deps = dependencies({
      // Seçimden sonra, silmeden önce bir sohbet bağlanır.
      isHostSynced: () => {
        checks += 1;
        if (checks === 1) seedConversation('conv-late', 'ghost');
        return true;
      },
    });
    const result = await runGhostFreeChatCleanup(deps, { openTaskIds: [] });
    expect(result).toMatchObject({ status: 'done', removed: [] });
    expect(remainingTaskIds()).toEqual(['ghost']);
    expect(deps.deleteTask).not.toHaveBeenCalled();
  });

  it('keeps going and does not record completion when a deletion fails', async () => {
    await seedTask('ghost-a', 'Claude (1)');
    await seedTask('ghost-b', 'Claude (2)');
    const deps = dependencies({
      deleteTask: vi.fn(async (_projectId: string, taskId: string) => {
        if (taskId === 'ghost-a') throw new Error('boom');
        fixture.sqlite.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
      }),
    });
    const result = await runGhostFreeChatCleanup(deps, { openTaskIds: [] });
    expect(result).toMatchObject({ status: 'done', failed: ['ghost-a'], completed: false });
    expect(remainingTaskIds()).toEqual(['ghost-a']);
    expect(deps.writeCompletedVersion).not.toHaveBeenCalled();
  });
});
