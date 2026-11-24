import { ReplicaState } from '@orkestra/wire/live';
import type { Connection, LiveClientHandle } from '@orkestra/wire/rpc';
import { WireError } from '@orkestra/wire/rpc';

/**
 * Masaüstü sözleşmeleri (zod) bu pakete taşınmaz: izin listesindeki yordamlar yol adıyla çağrılır,
 * yanıtlar `mappers.ts` içinde gevşekçe doğrulanır. İzin listesi:
 * `agents/architecture/remote-access.md` §7. Listede olmayan bir yol çağrılmaz.
 */
export const REMOTE_PROCEDURES = [
  'projects.resolveRepositoryDestination',
  'projects.createProject',
  'tasks.createTask',
  'conversations.getConversations',
  'conversations.getConversationsForTask',
  'conversations.getConversationsForProject',
  'conversations.createConversation',
  'conversations.markConversationSeen',
  'conversations.acp.attach',
  'conversations.acp.loadHistory',
  'conversations.acp.sendPrompt',
  'conversations.acp.cancelTurn',
  'conversations.acp.setOption',
  'conversations.acp.cancelSubagent',
  'conversations.acp.resolvePermission',
  'conversations.handoff.listAll',
  'conversations.handoff.put',
  'conversations.handoff.markSuperseded',
  'agents.listMetadata',
  'agents.accountUsage',
  'usageLimits.get',
  'sourceControl.checkout.getChangedFiles',
  'sourceControl.checkout.getFileHunks',
] as const;
export type RemoteProcedure = (typeof REMOTE_PROCEDURES)[number];

export const REMOTE_TOPICS = {
  projects: 'projects.projectList.list',
  tasks: 'tasks.taskList.list',
  sessionsList: 'conversations.acp.sessions.list',
  sessionState: 'conversations.acp.session.state',
  sessionConfig: 'conversations.acp.session.config',
  sessionUsage: 'conversations.acp.session.usage',
  sessionPlan: 'conversations.acp.session.plan',
  sessionAgents: 'conversations.acp.session.agents',
  sessionActiveTurn: 'conversations.acp.session.activeTurn',
  authList: 'agents.auth.list',
} as const;

export const LOCAL_HOST = { type: 'local', id: 'local' } as const;

/** Anahtarları sıralı JSON; masaüstünün `stableStringify` biçimiyle aynı topic dizesini üretir. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function topicOf(refId: string, key?: unknown): string {
  return key === undefined ? refId : `${refId}|${stableJson(key)}`;
}

/** Çağrı başarısızlığı; mesaj kullanıcıya gösterilebilir, ham sunucu ayrıntısı içermez. */
export class RemoteCallError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = 'RemoteCallError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Masaüstü `Result<T,E>` ({success,data|error}) ya da düz değer döndürebilir. */
export function unwrapResult(value: unknown): unknown {
  if (isRecord(value) && typeof value['success'] === 'boolean') {
    if (value['success']) return value['data'];
    const error = value['error'];
    const detail =
      isRecord(error) && typeof error['message'] === 'string'
        ? error['message']
        : isRecord(error) && typeof error['type'] === 'string'
          ? error['type']
          : 'işlem reddedildi';
    throw new RemoteCallError(`Masaüstü işlemi reddetti: ${detail}`, 'RESULT_ERROR');
  }
  return value;
}

export function describeCallError(error: unknown): string {
  if (error instanceof RemoteCallError) return error.message;
  if (error instanceof WireError) {
    switch (error.code) {
      case 'UNKNOWN_PROCEDURE':
      case 'UNKNOWN_TOPIC':
        return 'Bu işlem uzak erişimde desteklenmiyor.';
      case 'CONTRACT_MISMATCH':
        return 'İstek masaüstü tarafından geçersiz bulundu.';
      case 'DISCONNECTED':
        return 'Masaüstü ile bağlantı yok.';
      case 'TIMEOUT':
        return 'Masaüstü zamanında yanıt vermedi.';
    }
    return 'Masaüstü isteği tamamlayamadı.';
  }
  return 'Beklenmeyen bir hata oluştu.';
}

export type RemoteApi = {
  call(path: RemoteProcedure, input: unknown): Promise<unknown>;
  live<T>(topic: string, onChange: (value: T, meta: LiveChangeInfo) => void): LiveSubscription<T>;
};

/** `seed`: ilk anlık görüntü ya da yeniden bağlanma sonrası tazeleme (güncelleme değil). */
export type LiveChangeInfo = { seed: boolean };

export type LiveSubscription<T> = {
  /** İlk anlık görüntü alınınca çözülür; konu reddedilirse reddedilir. */
  ready: Promise<void>;
  current(): T | undefined;
  dispose(): void;
};

function handleFor<T>(connection: Connection, topic: string): LiveClientHandle<T> {
  return {
    topic,
    snapshot: () => connection.snapshot(topic) as never,
    attach: (push, options) => connection.attach(topic, push, options),
    asLiveSource() {
      return {
        snapshot: () => connection.snapshot(topic),
        subscribe: (cb, options) =>
          connection.attach(topic, cb, {
            onReattach: options?.onGap,
            onReattachError: options?.onError,
            signal: options?.signal,
          }),
      };
    },
  };
}

export function createRemoteApi(connection: Connection): RemoteApi {
  return {
    async call(path, input) {
      if (!(REMOTE_PROCEDURES as readonly string[]).includes(path)) {
        throw new RemoteCallError('Bu işlem uzak erişimde desteklenmiyor.', 'NOT_ALLOWED');
      }
      return connection.call(path, input);
    },
    live<T>(
      topic: string,
      onChange: (value: T, meta: LiveChangeInfo) => void
    ): LiveSubscription<T> {
      const replica = new ReplicaState<T>(handleFor<T>(connection, topic), {
        onChange: (value, meta) => onChange(value, { seed: meta.kind === 'seed' }),
      });
      let ready = false;
      const readyPromise = replica.ready.then(() => {
        ready = true;
      });
      // Reddedilen konu (ready) çağıran tarafından işlenir; yakalanmamış reddetme olmasın.
      readyPromise.catch(() => {});
      return {
        ready: readyPromise,
        current: () => (ready ? replica.current() : undefined),
        dispose: () => void replica.dispose().catch(() => {}),
      };
    },
  };
}

export type MobileGitChange = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

export type MobileGitDiffHunk = {
  id: string;
  header: string;
  lines: string[];
};

export async function fetchChangedFiles(
  api: RemoteApi,
  workspaceId: string,
  targetKind: 'working-vs-index' | 'staged-vs-head'
): Promise<MobileGitChange[]> {
  const data = unwrapResult(
    await api.call('sourceControl.checkout.getChangedFiles', {
      workspaceId,
      target: { kind: targetKind },
    })
  );
  if (!isRecord(data) || !Array.isArray(data['files'])) return [];
  const out: MobileGitChange[] = [];
  for (const item of data['files']) {
    if (!isRecord(item) || typeof item['path'] !== 'string') continue;
    out.push({
      path: item['path'],
      status: typeof item['status'] === 'string' ? item['status'] : 'modified',
      additions: typeof item['additions'] === 'number' ? item['additions'] : 0,
      deletions: typeof item['deletions'] === 'number' ? item['deletions'] : 0,
    });
  }
  return out;
}

export async function fetchFileHunks(
  api: RemoteApi,
  workspaceId: string,
  path: string,
  scope: 'unstaged' | 'staged'
): Promise<MobileGitDiffHunk[]> {
  const data = unwrapResult(
    await api.call('sourceControl.checkout.getFileHunks', {
      workspaceId,
      path,
      scope,
    })
  );
  if (!isRecord(data) || !Array.isArray(data['hunks'])) return [];
  const out: MobileGitDiffHunk[] = [];
  for (const item of data['hunks']) {
    if (!isRecord(item) || typeof item['id'] !== 'string') continue;
    out.push({
      id: item['id'],
      header: typeof item['header'] === 'string' ? item['header'] : '',
      lines: Array.isArray(item['lines'])
        ? item['lines'].filter((line): line is string => typeof line === 'string')
        : [],
    });
  }
  return out;
}
