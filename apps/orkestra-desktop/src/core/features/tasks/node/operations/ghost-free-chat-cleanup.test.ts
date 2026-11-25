import { describe, expect, it } from 'vitest';
import { FREE_CHAT_PROJECT_ID } from '@core/primitives/projects/api';
import {
  classifyGhostFreeChat,
  GHOST_FREE_CHAT_GRACE_MS,
  parseTaskTimestamp,
  selectGhostFreeChatTasks,
  type GhostFreeChatCandidate,
  type GhostFreeChatSelectionContext,
} from './ghost-free-chat-cleanup';

const NOW = Date.parse('2026-11-25T16:00:00.000Z');

function ghost(overrides: Partial<GhostFreeChatCandidate> = {}): GhostFreeChatCandidate {
  return {
    id: 'ghost-1',
    projectId: FREE_CHAT_PROJECT_ID,
    name: 'Claude (1)',
    type: 'task',
    createdAt: '2026-11-25T08:57:42.393Z',
    deletedAt: null,
    isPinned: false,
    conversationCount: 0,
    terminalCount: 0,
    host: { location: 'local', sshConnectionId: null },
    ...overrides,
  };
}

function context(
  overrides: Partial<GhostFreeChatSelectionContext> = {}
): GhostFreeChatSelectionContext {
  return {
    now: NOW,
    providerIds: ['claude', 'codex', 'antigravity', 'kimi', 'glm', 'grok'],
    openTaskIds: new Set(),
    isHostSynced: () => true,
    ...overrides,
  };
}

describe('classifyGhostFreeChat', () => {
  it('selects an old, empty, provider-default-named free chat', () => {
    expect(classifyGhostFreeChat(ghost(), context())).toBe('ghost');
    expect(classifyGhostFreeChat(ghost({ name: 'Antigravity (1)' }), context())).toBe('ghost');
    expect(classifyGhostFreeChat(ghost({ name: 'codex (12)' }), context())).toBe('ghost');
  });

  it('never selects a task with any conversation row, including tombstoned or untracked ones', () => {
    for (const conversationCount of [1, 2, 7]) {
      expect(classifyGhostFreeChat(ghost({ conversationCount }), context())).toBe(
        'has-conversations'
      );
    }
  });

  it('never selects a task with a terminal', () => {
    expect(classifyGhostFreeChat(ghost({ terminalCount: 1 }), context())).toBe('has-terminals');
  });

  it('never selects a user-given or placeholder name', () => {
    for (const name of [
      'Yeni sohbet',
      'Kedi Görseli Üret',
      'Claude',
      'Claude (0)',
      'Claude (01)',
      'Claude (1) notları',
      'Benim Claude (1)',
      'Unknownagent (1)',
      '',
      'Proje (2)',
    ]) {
      expect(classifyGhostFreeChat(ghost({ name }), context()), name).toBe('named');
    }
  });

  it('recognises default names only for known providers', () => {
    expect(
      classifyGhostFreeChat(ghost({ name: 'Myagent (1)' }), context({ providerIds: ['claude'] }))
    ).toBe('named');
    expect(
      classifyGhostFreeChat(ghost({ name: 'Myagent (1)' }), context({ providerIds: ['myagent'] }))
    ).toBe('ghost');
  });

  it('never selects a recently created task (grace period)', () => {
    const justNow = new Date(NOW - 1_000).toISOString();
    const insideGrace = new Date(NOW - GHOST_FREE_CHAT_GRACE_MS + 1).toISOString();
    const atGrace = new Date(NOW - GHOST_FREE_CHAT_GRACE_MS).toISOString();
    expect(classifyGhostFreeChat(ghost({ createdAt: justNow }), context())).toBe('recent');
    expect(classifyGhostFreeChat(ghost({ createdAt: insideGrace }), context())).toBe('recent');
    expect(classifyGhostFreeChat(ghost({ createdAt: atGrace }), context())).toBe('ghost');
    // Gelecekteki (saat kayması) ve okunamayan zaman damgaları da yeni sayılır.
    expect(classifyGhostFreeChat(ghost({ createdAt: '2026-11-26T00:00:00.000Z' }), context())).toBe(
      'recent'
    );
    expect(classifyGhostFreeChat(ghost({ createdAt: 'not a date' }), context())).toBe('recent');
  });

  it('reads SQLite CURRENT_TIMESTAMP values as UTC', () => {
    expect(parseTaskTimestamp('2026-11-25 08:57:42')).toBe(Date.parse('2026-11-25T08:57:42Z'));
    expect(classifyGhostFreeChat(ghost({ createdAt: '2026-11-25 15:55:00' }), context())).toBe(
      'recent'
    );
    expect(classifyGhostFreeChat(ghost({ createdAt: '2026-11-25 10:43:56' }), context())).toBe(
      'ghost'
    );
  });

  it('never selects the currently open task', () => {
    expect(classifyGhostFreeChat(ghost(), context({ openTaskIds: new Set(['ghost-1']) }))).toBe(
      'open'
    );
  });

  it('never selects a task whose host has not synced this session', () => {
    const remote = ghost({ host: { location: 'remote', sshConnectionId: 'ssh-huawei' } });
    const onlyLocal = context({ isHostSynced: (host) => host.location === 'local' });
    expect(classifyGhostFreeChat(remote, onlyLocal)).toBe('host-not-synced');
    expect(classifyGhostFreeChat(ghost(), onlyLocal)).toBe('ghost');
    // Çalışma alanı olmayan görev yerel makineye göre değerlendirilir.
    expect(
      classifyGhostFreeChat(ghost({ host: null }), context({ isHostSynced: () => false }))
    ).toBe('host-not-synced');
  });

  it('never selects tasks outside Sohbetler, deleted, pinned or automation runs', () => {
    expect(classifyGhostFreeChat(ghost({ projectId: 'project-1' }), context())).toBe(
      'not-free-chat'
    );
    expect(classifyGhostFreeChat(ghost({ deletedAt: '2026-11-25T09:00:00.000Z' }), context())).toBe(
      'deleted'
    );
    expect(classifyGhostFreeChat(ghost({ type: 'automation-run' }), context())).toBe(
      'not-regular-task'
    );
    expect(classifyGhostFreeChat(ghost({ isPinned: true }), context())).toBe('pinned');
  });
});

describe('selectGhostFreeChatTasks', () => {
  it('keeps exactly the ghosts from a mixed list (real-world shape)', () => {
    const candidates = [
      ghost({ id: '16e2f9d3', name: 'Claude (1)', createdAt: '2026-11-25T08:57:42.393Z' }),
      ghost({ id: '006ee845', name: 'Claude (1)', createdAt: '2026-11-25T10:43:56.186Z' }),
      ghost({ id: '44a71de5', name: 'Antigravity (1)', createdAt: '2026-11-25T10:44:02.566Z' }),
      // Sohbeti olan sağlayıcı-varsayılan adlı görevler kalır.
      ghost({ id: 'd8a27fbf', name: 'Claude (1)', conversationCount: 1 }),
      ghost({ id: '73c97f3b', name: 'Claude (1)', conversationCount: 1 }),
      // Boş ama kullanıcı/yer tutucu adlı görevler kalır.
      ghost({ id: 'yeni', name: 'Yeni sohbet' }),
      ghost({ id: 'named', name: 'Huawei Cihazda Bunun Örneği Var' }),
    ];
    expect(selectGhostFreeChatTasks(candidates, context()).map((c) => c.id)).toEqual([
      '16e2f9d3',
      '006ee845',
      '44a71de5',
    ]);
  });
});
