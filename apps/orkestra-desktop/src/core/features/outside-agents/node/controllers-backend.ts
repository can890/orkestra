import { randomUUID } from 'node:crypto';
import { formatHostRef, LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { encodeTopic, type Controller, type LiveSource } from '@orkestra/wire/rpc';
import type { AgentStatus } from '@core/primitives/agents/api';
import type {
  OutsideAgentBackend,
  OutsideConversation,
  OutsideHistoryPage,
  OutsideProject,
  OutsideProvider,
  OutsideSessionSummary,
  OutsideTranscriptItem,
  OutsideTranscriptTurn,
  StartConversationInput,
  StartConversationResult,
} from './outside-agent-backend';

/**
 * Dış ajan araçlarının arka ucu: masaüstü Wire denetleyicilerini, arayüzün ve mobil uygulamanın
 * çağırdığı yordamlarla süreç içinde çağırır. Böylece başlatılan sohbet arayüzde oluşturulmuş
 * gibi görevler/sohbetler canlı modellerine düşer. Kullanılan yollar:
 * `projects.projectList.list`, `conversations.getConversations`, `conversations.acp.sessions.list`,
 * `conversations.acp.loadHistory`, `conversations.acp.getCachedHistory`, `agents.list`,
 * `agents.listMetadata`, `tasks.createTask`, `conversations.acp.attach`,
 * `conversations.acp.sendPrompt`.
 */

const LIVE_SNAPSHOT_TIMEOUT_MS = 5_000;

type Fallible<T> = { success: true; data: T } | { success: false; error: unknown };

export function createControllersBackend(
  controllers: Record<string, Controller>
): OutsideAgentBackend {
  const call = async (path: string, input: unknown): Promise<unknown> => {
    const [domain, ...rest] = path.split('.');
    const controller = domain ? controllers[domain] : undefined;
    if (!controller || rest.length === 0)
      throw new Error(`Orkestra procedure unavailable: ${path}`);
    return await controller.call(rest.join('.'), input);
  };

  const snapshot = async (topic: string): Promise<unknown> => {
    const [domain] = topic.split('.', 1);
    const controller = domain ? controllers[domain] : undefined;
    const localTopic = topic.slice((domain?.length ?? 0) + 1);
    if (!controller) throw new Error(`Orkestra live model unavailable: ${topic}`);
    const lease = controller.acquireLive(localTopic);
    if (lease) {
      try {
        const source = await withTimeout(lease.ready(), LIVE_SNAPSHOT_TIMEOUT_MS);
        return (await withTimeout(Promise.resolve(source.snapshot()), LIVE_SNAPSHOT_TIMEOUT_MS))
          .data;
      } finally {
        void Promise.resolve(lease.release()).catch(() => {});
      }
    }
    const source: LiveSource | null = controller.resolveLive(localTopic);
    if (!source) throw new Error(`Orkestra live model unavailable: ${topic}`);
    return (await withTimeout(Promise.resolve(source.snapshot()), LIVE_SNAPSHOT_TIMEOUT_MS)).data;
  };

  const listProjects = async (): Promise<OutsideProject[]> => {
    const data = (await snapshot('projects.projectList.list')) as {
      projects?: Array<Record<string, unknown>>;
    } | null;
    return (data?.projects ?? []).flatMap((project) => {
      const id = stringOr(project.id);
      if (!id) return [];
      const isSsh = project.type === 'ssh';
      const connectionId = stringOr(project.connectionId);
      return [
        {
          id,
          name: stringOr(project.name) ?? id,
          path: stringOr(project.path) ?? '',
          location: isSsh ? ('ssh' as const) : ('local' as const),
          repositoryWorkspaceId: stringOr(project.repositoryWorkspaceId),
          hostKey:
            isSsh && connectionId
              ? formatHostRef({ type: 'remote', id: connectionId })
              : formatHostRef(LOCAL_HOST_REF),
        },
      ];
    });
  };

  const listConversations = async (projectId?: string): Promise<OutsideConversation[]> => {
    const raw = projectId
      ? await call('conversations.getConversationsForProject', { projectId })
      : await call('conversations.getConversations', undefined);
    const rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
    return rows.flatMap((row) => {
      const id = stringOr(row.id);
      const rowProjectId = stringOr(row.projectId);
      const taskId = stringOr(row.taskId);
      if (!id || !rowProjectId || !taskId) return [];
      return [
        {
          id,
          projectId: rowProjectId,
          taskId,
          providerId: stringOr(row.providerId) ?? 'unknown',
          title: stringOr(row.title) ?? '',
          type: row.type === 'acp' ? ('acp' as const) : ('pty' as const),
          model: stringOr(row.model),
          lastInteractedAt: stringOr(row.lastInteractedAt),
          agentStatus: (stringOr(row.agentStatus) as AgentStatus | null) ?? null,
          hasSession: typeof row.sessionId === 'string' && row.sessionId.length > 0,
        },
      ];
    });
  };

  return {
    listProjects,
    listConversations,

    async sessionSummaries(project) {
      const topic = `conversations.${encodeTopic('acp.sessions.list', {
        host: project.hostKey,
        projectId: project.id,
      })}`;
      const data = (await snapshot(topic)) as Record<string, Record<string, unknown>> | null;
      const summaries: Record<string, OutsideSessionSummary> = {};
      for (const [conversationId, summary] of Object.entries(data ?? {})) {
        summaries[conversationId] = {
          lifecycle: stringOr(summary.lifecycle) ?? 'closed',
          suspended: summary.suspended === true,
          isGenerating: summary.isGenerating === true,
          pendingPermissionCount: numberOr(summary.pendingPermissionCount, 0),
          queuedPromptCount: numberOr(summary.queuedPromptCount, 0),
          lastTurnErrored: summary.lastTurnErrored === true,
          updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : null,
        };
      }
      return summaries;
    },

    async loadLiveHistory(conversationId, limit, before): Promise<OutsideHistoryPage | null> {
      const result = (await call('conversations.acp.loadHistory', {
        conversationId,
        limit,
        ...(before !== undefined ? { before } : {}),
      })) as Fallible<{ turns?: unknown[]; nextCursor?: number | null; unavailable?: true }>;
      if (!result?.success || result.data.unavailable) return null;
      return {
        turns: (result.data.turns ?? []).map(mapTurn),
        nextCursor: typeof result.data.nextCursor === 'number' ? result.data.nextCursor : null,
      };
    },

    async loadCachedHistory(conversationId) {
      const result = (await call('conversations.acp.getCachedHistory', { conversationId })) as {
        turns?: unknown[];
      } | null;
      return (result?.turns ?? []).map(mapTurn);
    },

    async listProviders(): Promise<OutsideProvider[]> {
      let rows: Array<Record<string, unknown>> = [];
      let installedKnown = true;
      const listed = (await call('agents.list', { host: LOCAL_HOST_REF }).catch(
        () => null
      )) as Fallible<Array<Record<string, unknown>>> | null;
      if (listed?.success) {
        rows = listed.data;
      } else {
        installedKnown = false;
        const metadata = await call('agents.listMetadata', undefined).catch(() => []);
        rows = Array.isArray(metadata) ? (metadata as Array<Record<string, unknown>>) : [];
      }
      return rows.flatMap((row) => {
        const id = stringOr(row.id);
        const capabilities = (row.capabilities ?? {}) as Record<
          string,
          { kind?: string } | undefined
        >;
        // Dış ajanlar yalnızca sohbet (ACP) sağlayıcılarıyla konuşma başlatabilir.
        if (!id || capabilities.acp?.kind !== 'supported') return [];
        const models = capabilities.models as
          | {
              kind?: string;
              modelOptions?: Record<string, { name?: string; description?: string }>;
            }
          | undefined;
        return [
          {
            id,
            name: stringOr(row.name) ?? id,
            installed: installedKnown ? row.status === 'available' : null,
            supportsEffort: (capabilities.effort?.kind ?? 'none') !== 'none',
            models:
              models?.kind === 'selectable'
                ? Object.entries(models.modelOptions ?? {}).map(([modelId, option]) => ({
                    id: modelId,
                    name: option.name ?? modelId,
                    ...(option.description ? { description: option.description } : {}),
                  }))
                : [],
          },
        ];
      });
    },

    async startConversation(input: StartConversationInput): Promise<StartConversationResult> {
      const taskId = randomUUID();
      const conversationId = randomUUID();
      // Mobil uygulamanın ve hızlı görev oluşturmanın kullandığı aynı yol: görev + ilk ACP sohbeti.
      const created = (await call('tasks.createTask', {
        id: taskId,
        projectId: input.project.id,
        taskConfig: {
          version: '1',
          name: input.title,
          initialConversation: {
            id: conversationId,
            provider: input.provider,
            title: input.title,
            type: 'acp',
            initialPrompt: input.message,
            ...(input.model ? { model: input.model } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
          },
        },
        workspaceConfig: {
          version: '2',
          git: { kind: 'none' },
          workspace: input.project.repositoryWorkspaceId
            ? { kind: 'repository-instance', workspaceId: input.project.repositoryWorkspaceId }
            : { kind: 'new-worktree' },
        },
      })) as Fallible<unknown>;
      if (!created?.success) {
        throw new Error(`Could not create the conversation (${describeError(created?.error)}).`);
      }
      // Oturumu hemen bağla: ilk prompt kuyruğu arayüz açılmasa da işlenir.
      const attached = (await call('conversations.acp.attach', { conversationId }).catch(
        (error: unknown) => ({ success: false as const, error })
      )) as Fallible<unknown>;
      if (attached?.success) return { conversationId, taskId, started: true };
      return {
        conversationId,
        taskId,
        started: false,
        note: `The conversation was created but the agent did not start yet (${describeError(attached?.error)}). It starts when the conversation is opened in Orkestra.`,
      };
    },

    async sendMessage(conversationId, text, placement) {
      const attached = (await call('conversations.acp.attach', {
        conversationId,
      })) as Fallible<unknown>;
      if (!attached?.success) {
        throw new Error(
          `The agent session could not be started (${describeError(attached?.error)}).`
        );
      }
      const sent = (await call('conversations.acp.sendPrompt', {
        conversationId,
        promptId: randomUUID(),
        prompt: { text },
        placement,
      })) as Fallible<{ queued?: boolean }>;
      if (!sent?.success) {
        throw new Error(`The message was not accepted (${describeError(sent?.error)}).`);
      }
      return { queued: sent.data?.queued === true };
    },
  };
}

function mapTurn(raw: unknown): OutsideTranscriptTurn {
  const turn = (raw ?? {}) as {
    seq?: unknown;
    outcome?: { kind?: unknown };
    items?: unknown[];
  };
  const items: OutsideTranscriptItem[] = [];
  for (const entry of turn.items ?? []) {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (item.kind === 'message' && (item.role === 'user' || item.role === 'assistant')) {
      items.push({
        kind: 'message',
        role: item.role,
        text: typeof item.text === 'string' ? item.text : '',
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : null,
      });
    } else if (typeof item.kind === 'string' && item.kind.endsWith('tool-call')) {
      items.push({
        kind: 'tool',
        title: typeof item.title === 'string' ? item.title.slice(0, 300) : item.kind,
        status: typeof item.status === 'string' ? item.status : 'unknown',
      });
    }
  }
  return {
    seq: typeof turn.seq === 'number' ? turn.seq : 0,
    outcome: typeof turn.outcome?.kind === 'string' ? turn.outcome.kind : null,
    items,
  };
}

function stringOr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Hata nesnesinden yalnızca tür/mesaj; yol veya sır taşıyabilecek ayrıntılar dökülmez. */
function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const record = error as { type?: unknown; message?: unknown };
    if (typeof record.message === 'string' && record.message) return record.message.slice(0, 300);
    if (typeof record.type === 'string') return record.type;
  }
  if (error instanceof Error) return error.message.slice(0, 300);
  return 'unknown error';
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out reading Orkestra state.')), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
