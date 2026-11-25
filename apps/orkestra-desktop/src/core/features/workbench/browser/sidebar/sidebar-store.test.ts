import { observable, runInAction } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import * as sourceControlSelectors from '@core/features/source-control/api/browser/stores/source-control-selectors';
import type { TaskStore } from '@core/features/tasks/api/browser/stores/task-store';
import { taskManagerStoreToken } from '@core/features/tasks/contributions/browser/project-store-tokens';
import type { WorkbenchSidebarState } from '@core/features/workbench/contributions/mementos';
import type { MementoHandle } from '@core/primitives/mementos/browser';
import { FREE_CHAT_PROJECT_ID } from '@core/primitives/projects/api';
import { SidebarStore, taskMatchesFilter } from './sidebar-store';

type SidebarProjectManager = ConstructorParameters<typeof SidebarStore>[0];

vi.mock('@core/features/conversations/browser/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    conversationId = '';
    dispose() {}
    bootstrap() {}
  },
}));

vi.mock('@core/features/conversations/browser/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));

function projectManager(projects: { id: string; createdAt: string }[]): SidebarProjectManager {
  return {
    projects: new Map(projects.map((p) => [p.id, { ...p, context: null }])),
  } as unknown as SidebarProjectManager;
}

function task(id: string, createdAt: string) {
  return {
    state: 'provisioned',
    data: {
      id,
      type: 'coding-agent',
      isPinned: false,
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function projectManagerWithTasks(
  projects: { id: string; createdAt: string; taskIds: string[] }[]
): SidebarProjectManager {
  return {
    projects: new Map(
      projects.map((project) => {
        const taskManager = {
          tasks: new Map(
            project.taskIds.map((taskId, index) => [
              taskId,
              task(taskId, `2026-01-01T00:00:0${index}.000Z`),
            ])
          ),
        };
        return [
          project.id,
          {
            id: project.id,
            createdAt: project.createdAt,
            context: {
              kind: 'available',
              context: {
                get: (token: unknown) =>
                  token === taskManagerStoreToken ? taskManager : undefined,
              },
            },
          },
        ];
      })
    ),
  } as unknown as SidebarProjectManager;
}

function mementoHandle(initial: WorkbenchSidebarState): MementoHandle<WorkbenchSidebarState> {
  let value = initial;
  return {
    get value() {
      return value;
    },
    ready: Promise.resolve(),
    isPending: false,
    hasStoredValue: true,
    read: () => value,
    update: (next) => {
      value = typeof next === 'function' ? next(value) : next;
    },
    reset: async () => {},
    flush: async () => {},
    autoPersist: () =>
      (() => {}) as ReturnType<MementoHandle<WorkbenchSidebarState>['autoPersist']>,
    dispose: async () => {},
  };
}

describe('SidebarStore project ordering', () => {
  it('keeps a restored collapsed project collapsed during initial task hydration', () => {
    const tasks = observable.map<string, ReturnType<typeof task>>();
    const project = observable({
      id: 'project-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      context: null as null | {
        kind: 'available';
        context: { get: () => { tasks: typeof tasks } };
      },
    });
    const manager = {
      projects: observable.map([['project-1', project]]),
    } as unknown as SidebarProjectManager;
    const handle = mementoHandle({
      version: '1',
      expandedProjectIds: [],
      projectOrder: [],
      taskOrderByProject: {},
      taskSortBy: 'created-at',
    });
    const store = new SidebarStore(manager);
    store.attachMemento(handle);

    runInAction(() => {
      project.context = {
        kind: 'available',
        context: { get: () => ({ tasks }) },
      };
    });
    runInAction(() => {
      tasks.set('task-1', task('task-1', '2026-01-01T00:00:00.000Z'));
    });

    expect([...store.expandedProjectIds]).toEqual([]);
    expect(handle.value.expandedProjectIds).toEqual([]);
  });

  it('reads and writes through an attached memento', () => {
    const store = new SidebarStore(projectManager([]));
    const handle = mementoHandle({
      version: '1',
      expandedProjectIds: ['project-1'],
      projectOrder: ['project-1'],
      taskOrderByProject: {},
      taskSortBy: 'updated-at',
    });

    store.attachMemento(handle);
    expect([...store.expandedProjectIds]).toEqual(['project-1']);
    expect(store.taskSortBy).toBe('updated-at');

    store.setTaskSortBy('created-at');
    expect(handle.value.taskSortBy).toBe('created-at');
  });

  it('reveals a project without changing its persisted expansion preference', () => {
    const store = new SidebarStore(projectManager([{ id: 'project-1', createdAt: '2026-01-01' }]));
    const handle = mementoHandle({
      version: '1',
      expandedProjectIds: [],
      projectOrder: [],
      taskOrderByProject: {},
      taskSortBy: 'created-at',
    });
    store.attachMemento(handle);

    store.revealProject('project-1');
    expect([...store.expandedProjectIds]).toEqual(['project-1']);
    expect(handle.value.expandedProjectIds).toEqual([]);

    store.toggleProjectExpanded('project-1');
    expect([...store.expandedProjectIds]).toEqual([]);
    expect(handle.value.expandedProjectIds).toEqual([]);
  });

  it('sorts projects newest first by default', () => {
    const store = new SidebarStore(
      projectManager([
        { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'new', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['new', 'old']);
  });

  it('places projects missing from a saved manual order first', () => {
    const store = new SidebarStore(
      projectManager([
        { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'manual', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'new', createdAt: '2026-01-03T00:00:00.000Z' },
      ])
    );

    store.setProjectOrder(['manual', 'old']);

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['new', 'manual', 'old']);
  });

  it('returns visible task entries in rendered project-tree order', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          taskIds: ['task-1a', 'task-1b'],
        },
        {
          id: 'project-2',
          createdAt: '2026-01-02T00:00:00.000Z',
          taskIds: ['task-2a'],
        },
      ])
    );

    store.setProjectOrder(['project-1', 'project-2']);
    store.toggleProjectExpanded('project-1');
    store.toggleProjectExpanded('project-2');
    store.setTaskOrder('project-1', ['task-1a', 'task-1b']);

    expect(store.visibleTaskEntries).toEqual([
      { projectId: 'project-1', taskId: 'task-1a' },
      { projectId: 'project-1', taskId: 'task-1b' },
      { projectId: 'project-2', taskId: 'task-2a' },
    ]);
  });

  it('excludes pinned automation runs from every sidebar selector', () => {
    const manager = projectManagerWithTasks([
      {
        id: 'project-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        taskIds: ['regular-task', 'automation-task'],
      },
    ]);
    const project = manager.projects.get('project-1')!;
    const context = project.context?.kind === 'available' ? project.context.context : undefined;
    const tasks = context!.get(taskManagerStoreToken).tasks;
    tasks.get('regular-task')!.data.isPinned = true;
    tasks.get('automation-task')!.data.isPinned = true;
    tasks.get('automation-task')!.data.type = 'automation-run';

    const store = new SidebarStore(manager);
    store.toggleProjectExpanded('project-1');

    expect(store.pinnedSidebarEntries).toEqual([
      { projectId: 'project-1', taskId: 'regular-task' },
    ]);
    expect(store.visibleTaskIdsForProject('project-1')).toEqual([]);
    expect(store.sidebarRows).toEqual([{ kind: 'project', projectId: 'project-1' }]);
  });

  it('serbest sohbet projesini Projeler ağacından gizler ve freeChatEntries altında listeler', () => {
    const manager = projectManagerWithTasks([
      {
        id: 'project-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        taskIds: ['repo-task'],
      },
      {
        id: FREE_CHAT_PROJECT_ID,
        createdAt: '2026-01-02T00:00:00.000Z',
        taskIds: ['free-1', 'free-2'],
      },
    ]);

    const store = new SidebarStore(manager);

    expect(store.orderedProjects.map((p) => p.id)).toEqual(['project-1']);
    expect(store.sidebarRows).toEqual([{ kind: 'project', projectId: 'project-1' }]);
    expect(store.freeChatEntries).toEqual([
      { projectId: FREE_CHAT_PROJECT_ID, taskId: 'free-2' },
      { projectId: FREE_CHAT_PROJECT_ID, taskId: 'free-1' },
    ]);
    expect(store.isEmpty).toBe(false);
  });
});

describe('SidebarStore search, status filter, and settledEntries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function richTask(
    id: string,
    overrides: {
      name?: string;
      createdAt?: string;
      lastInteractedAt?: string;
      archivedAt?: string;
      isPinned?: boolean;
      type?: 'task' | 'automation-run';
      conversations?: Record<string, number>;
      workspaceId?: string;
      taskBranch?: string;
      observedBranch?: string;
    } = {}
  ): TaskStore {
    return {
      state: 'provisioned',
      workspaceId: overrides.workspaceId ?? null,
      workspaceObservedPr: overrides.observedBranch
        ? {
            branch: overrides.observedBranch,
            prBreadcrumb: null,
            upstream: null,
            headOid: null,
            ahead: null,
            behind: null,
          }
        : null,
      data: {
        id,
        projectId: 'project-1',
        name: overrides.name ?? id,
        status: 'todo',
        isPinned: overrides.isPinned ?? false,
        type: overrides.type ?? 'task',
        createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
        updatedAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
        statusChangedAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
        lastInteractedAt: overrides.lastInteractedAt,
        archivedAt: overrides.archivedAt,
        conversations: overrides.conversations ?? {},
        ...(overrides.taskBranch ? { taskBranch: overrides.taskBranch } : {}),
      },
    } as unknown as TaskStore;
  }

  function richManager(
    projects: { id: string; name: string; createdAt: string; tasks: TaskStore[] }[]
  ): SidebarProjectManager {
    return {
      projects: new Map(
        projects.map((p) => {
          const taskManager = {
            tasks: new Map(p.tasks.map((t) => [t.data.id, t])),
          };
          return [
            p.id,
            {
              id: p.id,
              name: p.name,
              createdAt: p.createdAt,
              context: {
                kind: 'available',
                context: {
                  get: (token: unknown) =>
                    token === taskManagerStoreToken ? taskManager : undefined,
                },
              },
            },
          ];
        })
      ),
    } as unknown as SidebarProjectManager;
  }

  it('taskMatchesFilter matches task name, branch name, provider name, and parent project name', () => {
    vi.spyOn(sourceControlSelectors, 'getGitCheckoutStore').mockImplementation((wsId) =>
      wsId === 'ws-1' ? ({ branchName: 'feat/oauth-login' } as never) : undefined
    );

    const t1 = richTask('t1', {
      name: 'Ödeme formu düzelt',
      workspaceId: 'ws-1',
      conversations: { claude: 1, codex: 2 },
    });
    const t2 = richTask('t2', {
      name: 'Basit görev',
      taskBranch: 'fix/sidebar-scroll',
      conversations: { antigravity: 1 },
    });

    expect(taskMatchesFilter(t1, 'ÖDEME', 'all')).toBe(true);
    expect(taskMatchesFilter(t1, 'oauth-login', 'all')).toBe(true);
    expect(taskMatchesFilter(t1, 'codex', 'all')).toBe(true);
    expect(taskMatchesFilter(t1, 'claude code', 'all')).toBe(true);
    expect(taskMatchesFilter(t1, 'Orkestra', 'all', 'Orkestra Masaüstü')).toBe(true);
    expect(taskMatchesFilter(t1, 'olmayan', 'all', 'Başka Proje')).toBe(false);
    expect(taskMatchesFilter(t2, 'sidebar-scroll', 'all')).toBe(true);
    expect(taskMatchesFilter(t2, 'antigravity', 'all')).toBe(true);
  });

  it('auto-expands matching collapsed projects transiently without mutating persisted expandedProjectIds', () => {
    const manager = richManager([
      {
        id: 'proj-a',
        name: 'Alpha Repo',
        createdAt: '2026-01-01T00:00:00.000Z',
        tasks: [
          richTask('t-auth', { name: 'Auth flow', createdAt: '2026-01-01T00:00:01.000Z' }),
          richTask('t-other', { name: 'CSS tweak', createdAt: '2026-01-01T00:00:02.000Z' }),
        ],
      },
      {
        id: 'proj-b',
        name: 'Beta Repo',
        createdAt: '2026-01-02T00:00:00.000Z',
        tasks: [richTask('t-db', { name: 'DB index', createdAt: '2026-01-02T00:00:01.000Z' })],
      },
    ]);
    const handle = mementoHandle({
      version: '1',
      expandedProjectIds: [],
      projectOrder: ['proj-a', 'proj-b'],
      taskOrderByProject: {},
      taskSortBy: 'created-at',
    });

    const store = new SidebarStore(manager);
    store.attachMemento(handle);

    expect(store.sidebarRows).toEqual([
      { kind: 'project', projectId: 'proj-a' },
      { kind: 'project', projectId: 'proj-b' },
    ]);

    store.setSearchQuery('auth');

    expect([...store.expandedProjectIds]).toEqual([]);
    expect(handle.value.expandedProjectIds).toEqual([]);
    expect([...store.effectiveExpandedProjectIds]).toEqual(['proj-a']);
    expect(store.sidebarRows).toEqual([
      { kind: 'project', projectId: 'proj-a' },
      { kind: 'task', projectId: 'proj-a', taskId: 't-auth' },
    ]);
    expect(store.visibleTaskEntries).toEqual([{ projectId: 'proj-a', taskId: 't-auth' }]);

    store.setSearchQuery('');
    expect([...store.effectiveExpandedProjectIds]).toEqual([]);
    expect(store.sidebarRows).toEqual([
      { kind: 'project', projectId: 'proj-a' },
      { kind: 'project', projectId: 'proj-b' },
    ]);
  });

  it('filters active vs settled tasks across tree, pinned, free chats, and settledEntries', () => {
    vi.spyOn(conversationRegistry, 'get').mockImplementation((taskId) => {
      if (taskId === 't-active' || taskId === 'pinned-active' || taskId === 'free-active') {
        return { taskStatus: 'working', conversations: new Map() } as never;
      }
      return { taskStatus: null, conversations: new Map() } as never;
    });

    const manager = richManager([
      {
        id: 'proj-a',
        name: 'Alpha Repo',
        createdAt: '2026-01-01T00:00:00.000Z',
        tasks: [
          richTask('t-active', { name: 'Çalışan görev', createdAt: '2026-01-01T00:00:02.000Z' }),
          richTask('t-idle', { name: 'Bekleyen görev', createdAt: '2026-01-01T00:00:01.000Z' }),
          richTask('pinned-active', {
            name: 'Sabit çalışan',
            isPinned: true,
            createdAt: '2026-01-01T00:00:03.000Z',
          }),
          richTask('pinned-idle', {
            name: 'Sabit durgun',
            isPinned: true,
            createdAt: '2026-01-01T00:00:04.000Z',
          }),
          richTask('archived-older', {
            name: 'Eski arşiv',
            archivedAt: '2026-01-02T00:00:00.000Z',
          }),
          richTask('archived-auto', {
            name: 'Otomasyon arşivi',
            type: 'automation-run',
            archivedAt: '2026-01-05T00:00:00.000Z',
          }),
        ],
      },
      {
        id: FREE_CHAT_PROJECT_ID,
        name: 'Sohbetler',
        createdAt: '2026-01-02T00:00:00.000Z',
        tasks: [
          richTask('free-active', { name: 'Canlı sohbet', createdAt: '2026-01-02T00:00:01.000Z' }),
          richTask('free-idle', { name: 'Durgun sohbet', createdAt: '2026-01-02T00:00:02.000Z' }),
          richTask('free-archived', {
            name: 'Yeni arşiv sohbet',
            archivedAt: '2026-01-04T00:00:00.000Z',
          }),
        ],
      },
    ]);

    const store = new SidebarStore(manager);

    // Default ('all'): settledEntries includes archived regular tasks sorted desc
    expect(store.settledEntries).toEqual([
      { projectId: FREE_CHAT_PROJECT_ID, taskId: 'free-archived' },
      { projectId: 'proj-a', taskId: 'archived-older' },
    ]);

    // Filter 'active': only active tasks appear, settledEntries empty
    store.setStatusFilter('active');
    expect(store.sidebarRows).toEqual([
      { kind: 'project', projectId: 'proj-a' },
      { kind: 'task', projectId: 'proj-a', taskId: 't-active' },
    ]);
    expect(store.pinnedSidebarEntries).toEqual([{ projectId: 'proj-a', taskId: 'pinned-active' }]);
    expect(store.freeChatEntries).toEqual([
      { projectId: FREE_CHAT_PROJECT_ID, taskId: 'free-active' },
    ]);
    expect(store.settledEntries).toEqual([]);

    // Filter 'settled': idle non-archived tasks in tree + archived tasks in settledEntries
    store.setStatusFilter('settled');
    expect(store.sidebarRows).toEqual([
      { kind: 'project', projectId: 'proj-a' },
      { kind: 'task', projectId: 'proj-a', taskId: 't-idle' },
    ]);
    expect(store.pinnedSidebarEntries).toEqual([{ projectId: 'proj-a', taskId: 'pinned-idle' }]);
    expect(store.freeChatEntries).toEqual([
      { projectId: FREE_CHAT_PROJECT_ID, taskId: 'free-idle' },
    ]);
    expect(store.settledEntries).toEqual([
      { projectId: FREE_CHAT_PROJECT_ID, taskId: 'free-archived' },
      { projectId: 'proj-a', taskId: 'archived-older' },
    ]);

    // Query narrows settledEntries as well and keeps isEmpty false
    store.setSearchQuery('yeni arşiv');
    expect(store.settledEntries).toEqual([
      { projectId: FREE_CHAT_PROJECT_ID, taskId: 'free-archived' },
    ]);
    expect(store.sidebarRows).toEqual([]);
    expect(store.isEmpty).toBe(false);
  });
});

describe('SidebarStore free chat ("Sohbetler") ordering', () => {
  function freeChat(
    id: string,
    createdAt: string,
    overrides: { name?: string; lastInteractedAt?: string; state?: string } = {}
  ): TaskStore {
    return {
      state: overrides.state ?? 'provisioned',
      workspaceId: null,
      workspaceObservedPr: null,
      data: {
        id,
        projectId: FREE_CHAT_PROJECT_ID,
        name: overrides.name ?? id,
        status: 'todo',
        isPinned: false,
        type: 'task',
        createdAt,
        updatedAt: createdAt,
        statusChangedAt: createdAt,
        lastInteractedAt: overrides.lastInteractedAt,
        conversations: {},
      },
    } as unknown as TaskStore;
  }

  function freeChatManager(initial: TaskStore[]) {
    const tasks = observable.map(new Map(initial.map((t) => [t.data.id, t])));
    const manager = {
      projects: new Map([
        [
          FREE_CHAT_PROJECT_ID,
          {
            id: FREE_CHAT_PROJECT_ID,
            name: 'Sohbetler',
            createdAt: '2026-01-01T00:00:00.000Z',
            context: {
              kind: 'available',
              context: {
                get: (token: unknown) => (token === taskManagerStoreToken ? { tasks } : undefined),
              },
            },
          },
        ],
      ]),
    } as unknown as SidebarProjectManager;
    return { manager, tasks };
  }

  const ids = (store: SidebarStore) => store.freeChatEntries.map((entry) => entry.taskId);

  function emptyState(): WorkbenchSidebarState {
    return {
      version: '1',
      expandedProjectIds: [],
      projectOrder: [],
      taskOrderByProject: {},
      taskSortBy: 'updated-at',
    };
  }

  it('lists newest first by creation time even when SQLite and ISO timestamps are mixed', () => {
    const { manager } = freeChatManager([
      // Adopted/eşitlenmiş satırlar ISO, createTask ile açılanlar SQLite CURRENT_TIMESTAMP biçiminde.
      freeChat('older-iso', '2026-11-25T08:57:42.393Z'),
      freeChat('newest-sqlite', '2026-11-25 10:43:56'),
      freeChat('middle-iso', '2026-11-25T09:30:00.000Z'),
    ]);
    const store = new SidebarStore(manager);
    expect(ids(store)).toEqual(['newest-sqlite', 'middle-iso', 'older-iso']);
  });

  it('ignores activity: a busy older chat does not jump above a newer one', () => {
    const { manager } = freeChatManager([
      freeChat('old-busy', '2026-11-24T10:00:00.000Z', {
        lastInteractedAt: '2026-11-25T12:00:00.000Z',
      }),
      freeChat('new-quiet', '2026-11-25T09:00:00.000Z'),
    ]);
    const store = new SidebarStore(manager);
    store.attachMemento(mementoHandle(emptyState()));
    expect(ids(store)).toEqual(['new-quiet', 'old-busy']);
  });

  it('puts a brand-new (still unregistered) chat on top of a manually ordered list', () => {
    const { manager, tasks } = freeChatManager([
      freeChat('a', '2026-11-20T10:00:00.000Z'),
      freeChat('b', '2026-11-21T10:00:00.000Z'),
    ]);
    const handle = mementoHandle({
      ...emptyState(),
      taskOrderByProject: { [FREE_CHAT_PROJECT_ID]: ['a', 'b'] },
    });
    const store = new SidebarStore(manager);
    store.attachMemento(handle);
    expect(ids(store)).toEqual(['a', 'b']);

    runInAction(() => {
      tasks.set('fresh', freeChat('fresh', '2026-11-25T11:00:00.000Z', { state: 'unregistered' }));
    });
    expect(ids(store)).toEqual(['fresh', 'a', 'b']);
  });

  it('persists drag-and-drop and keyboard moves through the sidebar memento', () => {
    const { manager } = freeChatManager([
      freeChat('a', '2026-11-23T10:00:00.000Z'),
      freeChat('b', '2026-11-22T10:00:00.000Z'),
      freeChat('c', '2026-11-21T10:00:00.000Z'),
    ]);
    const handle = mementoHandle(emptyState());
    const store = new SidebarStore(manager);
    store.attachMemento(handle);
    expect(ids(store)).toEqual(['a', 'b', 'c']);

    // c'yi a'nın üstüne bırak.
    expect(store.dropFreeChat('c', 'a', true)).toBe(true);
    expect(ids(store)).toEqual(['c', 'a', 'b']);
    expect(handle.value.taskOrderByProject[FREE_CHAT_PROJECT_ID]).toEqual(['c', 'a', 'b']);

    expect(store.moveFreeChatBy('b', -1)).toBe(true);
    expect(ids(store)).toEqual(['c', 'b', 'a']);
    expect(store.moveFreeChatBy('c', -1)).toBe(false);
    expect(store.dropFreeChat('missing', 'a', true)).toBe(false);

    // Yeniden başlatma: aynı memento değeriyle yeni bir mağaza aynı sırayı okur.
    const restored = new SidebarStore(manager);
    restored.attachMemento(mementoHandle(handle.value));
    expect(ids(restored)).toEqual(['c', 'b', 'a']);
  });

  it('disables reordering while a search filter is active and keeps the same relative order', () => {
    const { manager } = freeChatManager([
      freeChat('a', '2026-11-23T10:00:00.000Z', { name: 'Kedi görseli' }),
      freeChat('b', '2026-11-22T10:00:00.000Z', { name: 'Rapor' }),
      freeChat('c', '2026-11-21T10:00:00.000Z', { name: 'Kedi videosu' }),
    ]);
    const handle = mementoHandle({
      ...emptyState(),
      taskOrderByProject: { [FREE_CHAT_PROJECT_ID]: ['c', 'b', 'a'] },
    });
    const store = new SidebarStore(manager);
    store.attachMemento(handle);
    expect(store.canReorderFreeChats).toBe(true);

    store.setSearchQuery('kedi');
    expect(ids(store)).toEqual(['c', 'a']);
    expect(store.canReorderFreeChats).toBe(false);
    expect(store.moveFreeChatBy('a', -1)).toBe(false);
    expect(store.dropFreeChat('a', 'c', true)).toBe(false);
    expect(handle.value.taskOrderByProject[FREE_CHAT_PROJECT_ID]).toEqual(['c', 'b', 'a']);
  });

  it('keeps the free chat order when the project task sort is re-applied', () => {
    const { manager } = freeChatManager([freeChat('a', '2026-11-23T10:00:00.000Z')]);
    const handle = mementoHandle({
      ...emptyState(),
      taskOrderByProject: { [FREE_CHAT_PROJECT_ID]: ['a'], 'project-1': ['t1'] },
    });
    const store = new SidebarStore(manager);
    store.attachMemento(handle);
    store.applySort('created-at');
    expect(handle.value.taskOrderByProject).toEqual({ [FREE_CHAT_PROJECT_ID]: ['a'] });
    expect(handle.value.taskSortBy).toBe('created-at');
  });
});
