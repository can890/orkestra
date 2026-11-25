import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { encodeResourceUri, hostFileRef } from '@orkestra/core/primitives/path/api';
import { ok } from '@orkestra/shared';
import { deferred } from '@orkestra/shared/testing';
import { createController } from '@orkestra/wire/rpc';
import { createTestWire } from '@orkestra/wire/testing';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectEvents } from '@core/features/projects/api/node/project-events';
import { hostPathFromNative } from '@core/primitives/desktop-runtime/api';
import { portablePath } from '@core/primitives/desktop-runtime/api';
import { contentSearchRuntimeContract } from '../api';
import { createSearchService } from './search-service';

const mocks = vi.hoisted(() => ({
  fileSearch: vi.fn(),
  prepare: vi.fn(),
  workspaceGet: vi.fn(),
  getSearchExclusions: vi.fn(),
  warn: vi.fn(),
}));

vi.mock(import('@orkestra/shared/logger'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    log: { ...actual.log, info: vi.fn(), warn: mocks.warn },
  };
});

vi.mock('@core/features/conversations/api/node/conversation-events', () => ({
  conversationEvents: { on: vi.fn() },
}));

vi.mock('@core/features/projects/api/node/project-events', () => ({
  projectEvents: { on: vi.fn() },
}));

describe('SearchService runtime file search', () => {
  const root = hostPathFromNative('/repo');
  const rootRef = hostFileRef(LOCAL_HOST_REF, root);
  const relativePath = portablePath('src/index.ts');
  const hit = {
    resource: encodeResourceUri(
      hostFileRef(LOCAL_HOST_REF, hostPathFromNative('/repo/src/index.ts'))
    ),
    relativePath,
    filename: 'index.ts',
  };
  const searchService = createSearchService({
    db: {} as never,
    sqlite: { prepare: mocks.prepare } as never,
    acquireWorkspaceRuntime: mocks.workspaceGet,
    searchFileSearchRoot: mocks.fileSearch,
    getSearchExclusions: mocks.getSearchExclusions,
    tasks: { on: vi.fn() } as never,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceGet.mockReturnValue({
      identity: { host: LOCAL_HOST_REF },
      client: { fileSearch: { searchPaths: vi.fn() } },
      files: { root },
    });
    mocks.fileSearch.mockResolvedValue([hit]);
    mocks.getSearchExclusions.mockResolvedValue(['dist']);
  });

  it('delegates path search to the resolved workspace runtime', async () => {
    await expect(searchService.searchFiles('workspace-1', 'index', 25)).resolves.toEqual([hit]);
    expect(mocks.fileSearch).toHaveBeenCalledWith(
      expect.objectContaining({ searchPaths: expect.any(Function) }),
      rootRef,
      'index',
      25
    );
  });

  it('relays progressive content search through the resolved workspace runtime', async () => {
    const progressGate = deferred<void>();
    let didStartSearch = false;
    const files = [
      {
        path: portablePath('src/index.ts'),
        matches: [
          {
            lineNumber: 4,
            previewText: 'const test = true;',
            locations: [
              {
                sourceRange: { startColumn: 7, endColumn: 11 },
                previewRange: { startColumn: 7, endColumn: 11 },
              },
            ],
          },
        ],
      },
    ];
    const upstream = createTestWire(
      contentSearchRuntimeContract,
      createController(contentSearchRuntimeContract, {
        searchContent: {
          run: async (input, context) => {
            didStartSearch = true;
            expect(input).toEqual({ root, query: 'test', limit: 25, exclusions: ['dist'] });
            await progressGate.promise;
            context.progress({ files });
            return ok({ files, complete: true });
          },
        },
      })
    );
    mocks.workspaceGet.mockResolvedValue({
      client: { fileSearch: upstream.client },
      files: { root },
    });
    const progress: unknown[] = [];

    try {
      const result = searchService.searchContent(
        { workspaceId: 'workspace-1', query: 'test', limit: 25 },
        {
          jobId: 'desktop-search-1',
          signal: new AbortController().signal,
          progress: (update) => progress.push(update),
        }
      );
      await vi.waitFor(() => expect(didStartSearch).toBe(true));
      progressGate.resolve();

      await expect(result).resolves.toEqual(ok({ files, complete: true }));
      expect(progress).toEqual([{ files }]);
    } finally {
      await upstream.dispose();
    }
  });
});

describe('SearchService palette entity search', () => {
  it('re-titles an indexed project when it is renamed', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE VIRTUAL TABLE search_index USING fts5(
        item_type,
        item_id UNINDEXED,
        project_id UNINDEXED,
        task_id UNINDEXED,
        title,
        keywords,
        tokenize = 'trigram case_sensitive 0'
      );
      INSERT INTO search_index VALUES
        ('project', 'project-1', NULL, NULL, 'Old project', '/repo/old');
    `);
    const service = createSearchService({
      db: {} as never,
      sqlite,
      acquireWorkspaceRuntime: mocks.workspaceGet,
      searchFileSearchRoot: mocks.fileSearch,
      getSearchExclusions: mocks.getSearchExclusions,
      tasks: { on: vi.fn() } as never,
    });

    try {
      service.initialize();
      const onRenamed = vi
        .mocked(projectEvents.on)
        .mock.calls.find(([name]) => name === 'project:renamed')?.[1] as
        | ((projectId: string, name: string) => void)
        | undefined;
      expect(onRenamed).toBeDefined();
      onRenamed?.('project-1', 'Fresh project');

      await expect(
        service.searchEntities({ kind: 'project', query: 'fresh', context: {} })
      ).resolves.toEqual([expect.objectContaining({ id: 'project-1', title: 'Fresh project' })]);
      await expect(
        service.searchEntities({ kind: 'project', query: 'old project', context: {} })
      ).resolves.toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('returns kind-filtered candidates for one-character queries', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE VIRTUAL TABLE search_index USING fts5(
        item_type,
        item_id UNINDEXED,
        project_id UNINDEXED,
        task_id UNINDEXED,
        title,
        keywords,
        tokenize = 'trigram case_sensitive 0'
      );
      INSERT INTO search_index VALUES
        ('task', 'task-1', 'project-1', NULL, 'Theme task', 'THEME-123'),
        ('project', 'project-1', NULL, NULL, 'Theme project', '/repo/theme'),
        ('conversation', 'conversation-1', 'project-1', 'task-1', 'Theme chat', '');
    `);
    const service = createSearchService({
      db: {} as never,
      sqlite,
      acquireWorkspaceRuntime: mocks.workspaceGet,
      searchFileSearchRoot: mocks.fileSearch,
      getSearchExclusions: mocks.getSearchExclusions,
      tasks: { on: vi.fn() } as never,
    });

    try {
      await expect(
        service.searchEntities({
          kind: 'task',
          query: 't',
          context: { projectId: 'project-1' },
        })
      ).resolves.toEqual([
        {
          kind: 'task',
          id: 'task-1',
          projectId: 'project-1',
          taskId: null,
          title: 'Theme task',
          subtitle: 'THEME-123',
          score: 0,
        },
      ]);
      await expect(
        service.searchEntities({
          kind: 'task',
          query: 'tt',
          context: { projectId: 'project-1' },
        })
      ).resolves.toEqual([
        {
          kind: 'task',
          id: 'task-1',
          projectId: 'project-1',
          taskId: null,
          title: 'Theme task',
          subtitle: 'THEME-123',
          score: 0,
        },
      ]);
      await expect(
        service.searchEntities({
          kind: 'project',
          query: 't',
          context: { projectId: 'project-1' },
        })
      ).resolves.toEqual([
        {
          kind: 'project',
          id: 'project-1',
          projectId: null,
          taskId: null,
          title: 'Theme project',
          subtitle: '/repo/theme',
          score: 0,
        },
      ]);
      await expect(
        service.searchEntities({
          kind: 'conversation',
          query: 't',
          context: { projectId: 'project-1', taskId: 'task-1' },
        })
      ).resolves.toEqual([
        {
          kind: 'conversation',
          id: 'conversation-1',
          projectId: 'project-1',
          taskId: 'task-1',
          title: 'Theme chat',
          subtitle: '',
          score: 0,
        },
      ]);
      await expect(
        service.searchEntities({
          kind: 'conversation',
          query: 't',
          context: {},
        })
      ).resolves.toEqual([
        {
          kind: 'conversation',
          id: 'conversation-1',
          projectId: 'project-1',
          taskId: 'task-1',
          title: 'Theme chat',
          subtitle: '',
          score: 0,
        },
      ]);
      // Task-scoped entity search returns conversations in that task; omitting taskId searches globally across tasks.
      sqlite.exec(
        `INSERT INTO search_index VALUES ('conversation', 'conversation-2', 'project-1', 'other-task', 'Theme other', '')`
      );
      await expect(
        service.searchEntities({
          kind: 'conversation',
          query: 't',
          context: { taskId: 'other-task' },
        })
      ).resolves.toEqual([
        {
          kind: 'conversation',
          id: 'conversation-2',
          projectId: 'project-1',
          taskId: 'other-task',
          title: 'Theme other',
          subtitle: '',
          score: 0,
        },
      ]);
      await expect(
        service.searchEntities({
          kind: 'conversation',
          query: 't',
          context: {},
        })
      ).resolves.toEqual([
        {
          kind: 'conversation',
          id: 'conversation-1',
          projectId: 'project-1',
          taskId: 'task-1',
          title: 'Theme chat',
          subtitle: '',
          score: 0,
        },
        {
          kind: 'conversation',
          id: 'conversation-2',
          projectId: 'project-1',
          taskId: 'other-task',
          title: 'Theme other',
          subtitle: '',
          score: 0,
        },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('guards message indexing and search gracefully when message_search_fts is missing', () => {
    const sqlite = new Database(':memory:');
    const service = createSearchService({
      db: {} as never,
      sqlite,
      acquireWorkspaceRuntime: mocks.workspaceGet,
      searchFileSearchRoot: mocks.fileSearch,
      getSearchExclusions: mocks.getSearchExclusions,
      tasks: { on: vi.fn() } as never,
    });

    try {
      expect(() =>
        service.indexConversationMessages({
          conversationId: 'c1',
          projectId: 'p1',
          taskId: 't1',
          conversationTitle: 'Chat',
          messages: [{ itemId: 'm1', role: 'user', content: 'hello world' }],
        })
      ).not.toThrow();
      expect(() => service.removeConversationMessages('c1')).not.toThrow();
      expect(service.searchMessages({ query: 'hello' })).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('indexes messages, searches with trigram MATCH and LIKE fallback, and strips hidden context', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE VIRTUAL TABLE message_search_fts USING fts5(
        conversation_id UNINDEXED,
        project_id UNINDEXED,
        task_id UNINDEXED,
        item_id UNINDEXED,
        role UNINDEXED,
        conversation_title,
        content,
        created_at UNINDEXED,
        tokenize = 'trigram case_sensitive 0'
      );
    `);
    const service = createSearchService({
      db: {} as never,
      sqlite,
      acquireWorkspaceRuntime: mocks.workspaceGet,
      searchFileSearchRoot: mocks.fileSearch,
      getSearchExclusions: mocks.getSearchExclusions,
      tasks: { on: vi.fn() } as never,
    });

    try {
      service.indexConversationMessages({
        conversationId: 'c1',
        projectId: 'p1',
        taskId: 't1',
        conversationTitle: 'Mimari İnceleme',
        messages: [
          {
            itemId: 'm1',
            role: 'user',
            content:
              'Lütfen C++ foo-bar bağlantısını incele\n<orkestra_context>gizli talimat</orkestra_context>',
            createdAt: 1000,
          },
          {
            itemId: 'm2',
            role: 'assistant',
            content: '   ',
            createdAt: 1001,
          },
          {
            itemId: 'm3',
            role: 'assistant',
            content: 'SQLite trigram araması ve şüğöçı desteği eklendi.',
            createdAt: 1002,
          },
        ],
      });
      service.indexConversationMessages({
        conversationId: 'c2',
        projectId: 'p2',
        taskId: 't2',
        conversationTitle: 'Başka Sohbet',
        messages: [
          {
            itemId: 'm4',
            role: 'user',
            content: 'C++ ile bellek testi yaptık.',
            createdAt: 2000,
          },
        ],
      });

      // Hidden context must not be indexed
      expect(service.searchMessages({ query: 'gizli talimat' })).toEqual([]);

      // Special characters & trigram MATCH
      const cppHits = service.searchMessages({ query: 'C++ foo-bar' });
      expect(cppHits).toHaveLength(1);
      expect(cppHits[0]).toMatchObject({
        conversationId: 'c1',
        projectId: 'p1',
        taskId: 't1',
        itemId: 'm1',
        role: 'user',
        conversationTitle: 'Mimari İnceleme',
      });
      expect(cppHits[0]?.snippet).toContain('<mark>');
      expect(cppHits[0]?.score).toBeGreaterThan(0);

      // Turkish character search
      expect(service.searchMessages({ query: 'şüğöçı' })).toHaveLength(1);

      // 1-2 char LIKE fallback
      const shortHits = service.searchMessages({ query: 'C+' });
      expect(shortHits).toHaveLength(2);
      expect(shortHits[0]?.snippet).toContain('<mark>C+</mark>');

      // Project/task filtering
      expect(service.searchMessages({ query: 'C+', projectId: 'p2' })).toHaveLength(1);
      expect(service.searchMessages({ query: 'C+', taskId: 't1' })).toHaveLength(1);

      // Replacing conversation messages deletes previous items and removes on delete
      service.indexConversationMessages({
        conversationId: 'c1',
        projectId: 'p1',
        taskId: 't1',
        conversationTitle: 'Mimari İnceleme',
        messages: [{ itemId: 'm5', role: 'user', content: 'Tamamen yeni içerik', createdAt: 3000 }],
      });
      expect(service.searchMessages({ query: 'trigram' })).toEqual([]);
      expect(service.searchMessages({ query: 'yeni içerik' })).toHaveLength(1);

      service.removeConversationMessages('c1');
      expect(service.searchMessages({ query: 'yeni içerik' })).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
