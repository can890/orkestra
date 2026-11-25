import {
  createController,
  defineContract,
  liveModel,
  liveState,
  procedure,
  type Controller,
} from '@orkestra/wire/rpc';
import { cell, expose, type Cell } from '@orkestra/wire/state';
import { z } from 'zod';

/**
 * Test desteği: masaüstü uzak yüzeyini taklit eden küçük bir Wire denetleyicisi. Gerçek masaüstü
 * sözleşmeleri bu pakete taşınmaz; burada yalnızca istemcinin kullandığı yol/konu adları ve veri
 * biçimleri (agents/architecture/remote-access.md §7) bulunur.
 */
const ok = <T>(data: T) => ({ success: true as const, data });
const any = z.any();
const proc = () => procedure({ input: any, output: any });
const keyed = z.object({ conversationId: z.string() });

const conversationsContract = defineContract({
  getConversationsForTask: proc(),
  getConversationsForProject: proc(),
  markConversationSeen: proc(),
  readMediaPreview: proc(),
  acp: defineContract({
    attach: proc(),
    loadHistory: proc(),
    sendPrompt: proc(),
    cancelTurn: proc(),
    resolvePermission: proc(),
    session: liveModel({ key: keyed, states: { state: liveState({ data: any }) } }),
  }),
});
const projectsContract = defineContract({
  projectList: liveModel({ key: z.void(), states: { list: liveState({ data: any }) } }),
});
const tasksContract = defineContract({
  taskList: liveModel({
    key: z.object({ projectId: z.string() }),
    states: { list: liveState({ data: any }) },
  }),
});
const agentsContract = defineContract({
  listMetadata: proc(),
  auth: liveModel({
    key: z.object({ host: any }),
    states: { list: liveState({ data: any }) },
  }),
});
const usageContract = defineContract({ get: proc() });

export type FakeSessionState = Record<string, unknown>;

export type FakeDesktop = {
  controller: Controller;
  calls: { path: string; input: unknown }[];
  projects: Cell<unknown>;
  tasks: Cell<unknown>;
  auth: Cell<unknown>;
  session(conversationId: string): Cell<FakeSessionState>;
  /** `loadHistory` yanıtı: tüm turlar (artan seq); sayfalama `before`/`limit` ile yapılır. */
  history: unknown[];
  generation: string;
  historyRevision: number;
  /**
   * `readMediaPreview` için sanal dosya: içerik konumdan üretilir (`fakeMediaByte`), çok GB'lık
   * boyutlar bellekte oluşturulmaz. `legacy`: eski masaüstü (80 MB dosya / 40 MB konum sınırı).
   */
  media: { size: number; legacy: boolean };
};

/** Sanal medya dosyasının `pos` konumundaki baytı. */
export function fakeMediaByte(pos: number): number {
  return (pos * 31 + 7) & 0xff;
}

function fakeMediaRange(offset: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = fakeMediaByte(offset + i);
  return out;
}

export function createFakeDesktop(): FakeDesktop {
  const calls: FakeDesktop['calls'] = [];
  const sessions = new Map<string, Cell<FakeSessionState>>();
  const projects = cell<unknown>({
    projects: [
      { type: 'local', id: 'p1', name: 'Orkestra', path: '/work/orkestra' },
      { type: 'local', id: 'p2', name: 'Alfa', path: '/work/alfa' },
    ],
  });
  const tasks = cell<unknown>({
    tasks: [
      {
        id: 't1',
        projectId: 'p1',
        name: 'Mobil uygulama',
        status: 'in_progress',
        isPinned: false,
        updatedAt: '2026-01-02T00:00:00Z',
      },
      {
        id: 't2',
        projectId: 'p1',
        name: 'Eski görev',
        status: 'done',
        isPinned: false,
        updatedAt: '2026-01-01T00:00:00Z',
        archivedAt: '2026-01-03T00:00:00Z',
      },
    ],
  });
  const auth = cell<unknown>({
    claude: {
      providerId: 'claude',
      name: 'Claude',
      auth: { status: { kind: 'authenticated', account: 'ben@example.com' }, login: null },
    },
    codex: {
      providerId: 'codex',
      name: 'Codex',
      auth: { status: { kind: 'unauthenticated' }, login: null },
    },
  });

  const state: FakeDesktop = {
    controller: undefined as unknown as Controller,
    calls,
    projects,
    tasks,
    auth,
    history: [],
    generation: 'gen-1',
    historyRevision: 0,
    media: { size: 6 * 1024 * 1024 * 1024, legacy: false },
    session(conversationId) {
      let existing = sessions.get(conversationId);
      if (!existing) {
        existing = cell<FakeSessionState>({
          lifecycle: 'ready',
          activeTurnId: null,
          historyRevision: 0,
          transcript: {
            generation: state.generation,
            historyRevision: 0,
            lastCommittedTurnSeq: null,
            activeTurn: null,
          },
          pendingPermissions: [],
          queuedPrompts: [],
          isGenerating: false,
          canSubmit: true,
          canCancel: false,
        });
        sessions.set(conversationId, existing);
      }
      return existing;
    },
  };

  const record =
    <T>(path: string, handler: (input: Record<string, unknown>) => T) =>
    (input: unknown): T => {
      calls.push({ path, input });
      return handler((input ?? {}) as Record<string, unknown>);
    };

  const conversations = createController(conversationsContract, {
    getConversationsForTask: record('conversations.getConversationsForTask', () => [
      {
        id: 'c1',
        projectId: 'p1',
        taskId: 't1',
        providerId: 'claude',
        title: 'Ana sohbet',
        type: 'acp',
        lastInteractedAt: '2026-01-02T00:00:00Z',
      },
      {
        id: 'c2',
        projectId: 'p1',
        taskId: 't1',
        providerId: 'codex',
        title: 'Terminal',
        type: 'pty',
        lastInteractedAt: null,
      },
    ]),
    getConversationsForProject: record('conversations.getConversationsForProject', () => []),
    markConversationSeen: record('conversations.markConversationSeen', () => undefined),
    readMediaPreview: record('conversations.readMediaPreview', (input) => {
      const { size, legacy } = state.media;
      const offset = typeof input['offset'] === 'number' ? input['offset'] : 0;
      const maxBytes = typeof input['maxBytes'] === 'number' ? input['maxBytes'] : 1_400_000;
      if (legacy && size > 80 * 1024 * 1024) {
        throw new Error('Dosya mobil aktarım boyut sınırını (80 MB) aşıyor.');
      }
      const start = Math.min(offset, size);
      const length = Math.max(0, Math.min(maxBytes, size - start));
      return {
        name: 'render.mp4',
        mimeType: 'video/mp4',
        size,
        offset: start,
        base64: Buffer.from(fakeMediaRange(start, length)).toString('base64'),
        eof: start + length >= size,
        ...(legacy ? {} : { maxChunkBytes: 8 * 1024 * 1024 }),
      };
    }),
    acp: {
      attach: record('conversations.acp.attach', () => ok(undefined)),
      loadHistory: record('conversations.acp.loadHistory', (input) => {
        const before = typeof input['before'] === 'number' ? input['before'] : Infinity;
        const limit = typeof input['limit'] === 'number' ? input['limit'] : 50;
        const eligible = (state.history as { seq: number }[]).filter((turn) => turn.seq < before);
        const turns = eligible.slice(-limit);
        const first = turns[0]?.seq;
        const more = eligible.length > turns.length;
        return ok({
          turns,
          nextCursor: more && first !== undefined ? first : null,
          position: {
            generation: state.generation,
            historyRevision: state.historyRevision,
            lastCommittedTurnSeq: null,
          },
        });
      }),
      sendPrompt: record('conversations.acp.sendPrompt', () => ok({ queued: false })),
      cancelTurn: record('conversations.acp.cancelTurn', () => ok(undefined)),
      resolvePermission: record('conversations.acp.resolvePermission', () => ok(undefined)),
      session: expose(conversationsContract.acp.session, {
        state: (key) => state.session(key.conversationId),
      }),
    },
  });
  const projectsController = createController(projectsContract, {
    projectList: expose(projectsContract.projectList, { list: () => projects }),
  });
  const tasksController = createController(tasksContract, {
    taskList: expose(tasksContract.taskList, { list: () => tasks }),
  });
  const agentsController = createController(agentsContract, {
    listMetadata: record('agents.listMetadata', () => [{ id: 'claude', name: 'Claude' }]),
    auth: expose(agentsContract.auth, { list: () => auth }),
  });
  const usageController = createController(usageContract, {
    get: record('usageLimits.get', () => ({
      providers: [
        {
          providerId: 'claude',
          status: 'available',
          windows: [{ label: '5 saat', usedPercent: 42, resetsAt: '2026-01-02T05:00:00Z' }],
          balances: [],
          plan: 'Max',
          source: 'api',
          measuredAt: '2026-01-02T00:00:00Z',
          fetchedAt: 1,
        },
      ],
    })),
  });

  const controllers: Record<string, Controller> = {
    conversations,
    projects: projectsController,
    tasks: tasksController,
    agents: agentsController,
    usageLimits: usageController,
  };
  const route = (path: string) => {
    const [domain, ...rest] = path.split('.');
    const controller = domain ? controllers[domain] : undefined;
    return controller ? { controller, rest: rest.join('.') } : null;
  };

  state.controller = {
    async call(path, input, meta) {
      const routed = route(path);
      if (!routed) throw new Error(`unknown ${path}`);
      return routed.controller.call(routed.rest, input, meta);
    },
    resolveLive(topic) {
      const routed = route(topic);
      return routed ? routed.controller.resolveLive(routed.rest) : null;
    },
    acquireLive(topic) {
      const routed = route(topic);
      return routed ? routed.controller.acquireLive(routed.rest) : null;
    },
  };
  return state;
}
