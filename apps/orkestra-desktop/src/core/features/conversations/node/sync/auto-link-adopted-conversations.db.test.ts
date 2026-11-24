import type { ConversationRecord } from '@orkestra/core/runtimes/conversations/api';
import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FREE_CHAT_PROJECT_ID } from '@core/primitives/projects/api';
import {
  conversations,
  projects,
  sshConnections,
  tasks,
  workspaces,
} from '@core/services/app-db/node/schema';
import { applyConversationSnapshot } from './apply-conversation-snapshot';
import { autoLinkAdoptedConversations } from './auto-link-adopted-conversations';

function hostRecord(
  overrides: Partial<ConversationRecord> & { conversationId: string }
): ConversationRecord {
  return {
    provider: 'claude',
    type: 'acp',
    cwd: '/home/selim/.local/share/orkestra/free-chats',
    workspacePath: '/home/selim/.local/share/orkestra/free-chats',
    idRegime: 'provider-owned',
    createdAt: Date.parse('2026-11-24T14:00:00.000Z'),
    title: 'Yeni sohbet',
    config: { version: '1', type: 'acp' },
    providerSessionId: 'sess-123',
    providerSessionIdObservedAt: null,
    lastSessionActivityAt: Date.parse('2026-11-24T14:01:00.000Z'),
    lastSpawnedAt: null,
    lastResumeOutcome: 'never-resumed',
    updatedAt: Date.parse('2026-11-24T14:01:00.000Z'),
    ...overrides,
  };
}

describe('autoLinkAdoptedConversations', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
  });

  afterEach(() => {
    fixture.close();
  });

  it('links adopted remote free-chat conversations under Sohbetler with remote host workspace and syncs updated titles', async () => {
    const db = fixture.db;
    db.insert(sshConnections)
      .values({
        id: 'ssh-huawei',
        name: 'huawei',
        host: '192.168.1.148',
        port: 22,
        username: 'selim',
        authType: 'key',
      })
      .run();

    const host = { location: 'remote' as const, sshConnectionId: 'ssh-huawei' };
    await applyConversationSnapshot({
      db,
      host,
      records: {
        'conv-mobile-1': hostRecord({ conversationId: 'conv-mobile-1' }),
      },
    });

    const first = await autoLinkAdoptedConversations(db, host, {
      resolveHostWorkspaceId: async () => '74773747-1b74-454e-8309-1829e33787d7',
    });
    expect(first.linked).toBe(1);

    const [conv] = db
      .select()
      .from(conversations)
      .where(eq(conversations.id, 'conv-mobile-1'))
      .all();
    expect(conv?.projectId).toBe(FREE_CHAT_PROJECT_ID);
    expect(conv?.taskId).toBeTruthy();

    const [task] = db.select().from(tasks).where(eq(tasks.id, conv!.taskId!)).all();
    expect(task?.name).toBe('Yeni sohbet');
    expect(task?.projectId).toBe(FREE_CHAT_PROJECT_ID);
    expect(task?.workspaceId).toBe('74773747-1b74-454e-8309-1829e33787d7');

    const [ws] = db.select().from(workspaces).where(eq(workspaces.id, task!.workspaceId!)).all();
    expect(ws?.location).toBe('remote');
    expect(ws?.sshConnectionId).toBe('ssh-huawei');
    expect(ws?.path).toBe('/home/selim/.local/share/orkestra/free-chats');

    // İkinci kez çağrıldığında tekrar bağlamaz; başlık güncellenince görev adını eşitler.
    await applyConversationSnapshot({
      db,
      host,
      records: {
        'conv-mobile-1': hostRecord({
          conversationId: 'conv-mobile-1',
          title: 'Nano banana ile kedi görseli',
          updatedAt: Date.parse('2026-11-24T14:05:00.000Z'),
        }),
      },
    });
    const second = await autoLinkAdoptedConversations(db, host);
    expect(second.linked).toBe(0);
    expect(second.titlesSynced).toBe(1);

    const [renamedTask] = db.select().from(tasks).where(eq(tasks.id, conv!.taskId!)).all();
    expect(renamedTask?.name).toBe('Nano banana ile kedi görseli');
  });

  it('links adopted remote project conversations under the matching project', async () => {
    const db = fixture.db;
    db.insert(sshConnections)
      .values({
        id: 'ssh-huawei',
        name: 'huawei',
        host: '192.168.1.148',
        port: 22,
        username: 'selim',
        authType: 'key',
      })
      .run();
    db.insert(workspaces)
      .values({
        id: 'ws-canseller',
        type: 'project-ssh',
        kind: 'repository',
        location: 'remote',
        sshConnectionId: 'ssh-huawei',
        path: '/home/selim/projects/cansellerai',
        origin: 'registered',
        observedStatus: 'present',
      })
      .run();
    db.insert(projects)
      .values({
        id: 'proj-canseller',
        name: 'cansellerai',
        repositoryWorkspaceId: 'ws-canseller',
      })
      .run();

    const host = { location: 'remote' as const, sshConnectionId: 'ssh-huawei' };
    await applyConversationSnapshot({
      db,
      host,
      records: {
        'conv-proj-1': hostRecord({
          conversationId: 'conv-proj-1',
          provider: 'codex',
          cwd: '/home/selim/projects/cansellerai',
          workspacePath: '/home/selim/projects/cansellerai',
          title: 'Prime kargo yaması',
        }),
      },
    });

    const result = await autoLinkAdoptedConversations(db, host);
    expect(result.linked).toBe(1);

    const [conv] = db.select().from(conversations).where(eq(conversations.id, 'conv-proj-1')).all();
    expect(conv?.projectId).toBe('proj-canseller');
    const [task] = db.select().from(tasks).where(eq(tasks.id, conv!.taskId!)).all();
    expect(task?.workspaceId).toBe('ws-canseller');
    expect(task?.name).toBe('Prime kargo yaması');
  });
});
