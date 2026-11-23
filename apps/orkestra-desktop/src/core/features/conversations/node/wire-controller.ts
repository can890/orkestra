import {
  LOCAL_HOST_REF,
  parseHostRef,
  type HostRef,
  type SerializedHostRef,
} from '@orkestra/core/primitives/host/api';
import type {
  ResolvedConfiguration,
  SessionConfigState,
  SessionState,
} from '@orkestra/core/runtimes/acp/api';
import { acpErr } from '@orkestra/core/runtimes/acp/api/client';
import { gitErr } from '@orkestra/core/runtimes/git/api';
import { err, ok, toSerializedError, type Result } from '@orkestra/shared';
import type { Scope } from '@orkestra/shared/concurrency';
import type { Logger } from '@orkestra/shared/logger';
import type { LiveSource } from '@orkestra/wire/rpc';
import { createController, type CallMeta, type Controller } from '@orkestra/wire/rpc';
import { and, eq } from 'drizzle-orm';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import { createConversationOperations } from '@core/features/conversations/node/controller';
import type { CompensationRunner } from '@core/features/conversations/node/createConversation';
import {
  setConversationAcpConfigOption,
  type AcpPersistedConfigKey,
} from '@core/features/conversations/node/set-acp-config-option';
import { emitLifecycleHookEvent } from '@core/features/lifecycle-hooks/api/node/hook-event-bus';
import {
  OrchestraService,
  type OrchestraServiceDeps,
  type PendingPermission,
} from '@core/features/orchestra/api/node/orchestra-service';
import { WorkflowService } from '@core/features/orchestra/api/node/workflow-service';
import { createWorkflowWorkerPort } from '@core/features/orchestra/api/node/workflow-worker-port';
import { pickEffortOption } from '@core/features/orchestra/api/orchestra-models';
import type { ProjectMemoryPromptSource } from '@core/features/project-memory/api';
import type { ProjectAttachmentError } from '@core/features/projects/api';
import {
  requireAttachedProjectOrThrow,
  withAttachedProject,
} from '@core/features/projects/api/node/attached-project';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import { autoTitleTaskFromPrompt } from '@core/features/tasks/api/node/auto-title-task';
import type { TaskSessionLaunchContextResolver } from '@core/features/tasks/api/node/task-session-launch-context';
import type { TaskSessionManager } from '@core/features/tasks/api/node/task-session-manager';
import type { UsageLimitsReader } from '@core/features/usage-limits/api/usage-limits';
import type { SshClientProxy } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import type { TelemetryService } from '@core/primitives/telemetry/api/telemetry';
import type { ConversationMcpServerProvider } from '@core/services/agent-tools/api/agent-tools';
import type { AgentToolsBridgeHost } from '@core/services/agent-tools/node/agent-tools-host';
import type { AppDb } from '@core/services/app-db/node/db';
import { tasks } from '@core/services/app-db/node/schema';
import {
  prepareTerminalFiles,
  type TerminalFileSources,
} from '@core/services/attachments/node/prepare-terminal-files';
import { forwardLiveModel } from '@core/services/runtime-clients/node/forward-live-model';
import { conversationsContract } from '../api';
import {
  throwConversationsRuntimeResolveError,
  type ConversationsAcpStartInput,
  type ConversationsHostRuntimesClient,
  type ConversationsRuntimeBroker,
  type ConversationsRuntimeResolveError as RuntimeResolveError,
} from '../api/runtime-adapter';
import {
  withCheckpointSelector,
  deleteConversationCheckpoints,
  takePromptCheckpoint,
} from './conversation-checkpoints';
import {
  conversationLifecycleLock,
  assertConversationNotSwitching,
} from './conversation-lifecycle-lock';
import { collectConversationMcpServers } from './conversation-mcp-servers';
import { conversationWireEvents } from './event-host';
import { switchConversationView } from './switch-conversation-view';

/** How long a conductor tool call waits for a usage refresh before treating usage as unknown. */
const USAGE_WAIT_MS = 4_000;

type ConversationRuntimeTarget = Readonly<{
  conversationId: string;
  projectId: string;
  taskId: string;
  conversationType: 'pty' | 'acp';
  providerId: string | null;
  sessionId: string | null;
  model: string | null;
  modeId: string | null;
  effort: string | null;
  collaborationMode: string | null;
  workspaceId?: string;
  workspacePath?: string;
  host: HostRef;
  acpInput?: ConversationsAcpStartInput;
}>;

type WorkspaceIdentityResolver = Readonly<{
  resolve(workspaceId: string): Promise<{ host: HostRef; path: string } | null>;
}>;

type ConversationRuntimeHooks = Readonly<{
  persistAcpConfigOption(
    target: ConversationRuntimeTarget,
    key: AcpPersistedConfigKey,
    value: string | null
  ): Promise<void>;
  recordTuiInput(target: ConversationRuntimeTarget): Promise<void>;
}>;

export type CreateConversationsWireControllerOptions = Readonly<{
  db: AppDb;
  terminalFileSources: TerminalFileSources;
  runtimes: ConversationsRuntimeBroker;
  workspaceIdentity: WorkspaceIdentityResolver;
  resolveTarget?: (conversationId: string) => Promise<ConversationRuntimeTarget>;
  hooks?: ConversationRuntimeHooks;
  getProviderEnv?: (providerId: string) => Promise<Record<string, string> | undefined>;
  generateTaskTitle?: (prompt: string) => Promise<string | null>;
  sessionLaunchContexts: Pick<TaskSessionLaunchContextResolver, 'resolve'>;
  logger: Logger;
  projects: Pick<ProjectAttachmentManager, 'requireAttached'>;
  telemetry: TelemetryService;
  taskSessions: Pick<TaskSessionManager, 'getTask'>;
  withCompensation: CompensationRunner;
  hostIsReachable: (hostRef: SerializedHostRef) => boolean;
  /** Orkestra conductor/worker mode; orchestra procedures are disabled when omitted. */
  orchestra?: Readonly<{
    dataDirectory: string;
    electronExecutable: string;
    scope: Scope;
    getSshProxy?: (connectionId: string) => SshClientProxy | undefined;
    /** Shared agent tools plumbing (RPC server, bridge, SSH reverse tunnels). */
    agentTools?: AgentToolsBridgeHost;
    /** Subscription usage cache; lets the conductor avoid agents whose quota is nearly spent. */
    usage?: UsageLimitsReader;
  }>;
  /**
   * Conversation-scoped MCP servers added to every ACP session at attach time (e.g. the
   * Orkestra in-app browser). A failing provider never blocks the session; it is left out.
   */
  conversationMcpServers?: readonly ConversationMcpServerProvider[];
  /**
   * Ortak proje hafızası: ayarı açık projelerde, ilk (başlangıç) prompt'una dizin bloğunu gizli
   * bağlam olarak ekler. Başlangıç prompt'u olmayan sohbetlerde blok arayüzün ilk mesajına eklenir.
   */
  projectMemory?: ProjectMemoryPromptSource;
}>;

export function createConversationsWireController(
  options: CreateConversationsWireControllerOptions
): Controller {
  const resolveBaseTarget =
    options.resolveTarget ??
    ((conversationId) =>
      resolveConversationRuntimeTarget(
        conversationId,
        options.workspaceIdentity,
        options.db,
        options.getProviderEnv,
        options.sessionLaunchContexts
      ));
  let orchestra: OrchestraService | null = null;
  let workflows: WorkflowService | null = null;
  // Conductor conversations get the Orkestra MCP bridge so they can manage workers. On remote
  // hosts the bridge reaches this machine's RPC endpoint through an SSH reverse tunnel.
  const resolveTarget = async (conversationId: string): Promise<ConversationRuntimeTarget> => {
    const resolved = await resolveBaseTarget(conversationId);
    if (!orchestra || !resolved.acpInput) return resolved;
    const mcpServers = await orchestra.conductorMcpServers(conversationId, resolved.host);
    return mcpServers ? { ...resolved, acpInput: { ...resolved.acpInput, mcpServers } } : resolved;
  };
  const hooks = options.hooks ?? createDefaultRuntimeHooks(options);
  const conversationOperations = createConversationOperations({
    db: options.db,
    taskSessions: options.taskSessions,
    telemetry: options.telemetry,
    withCompensation: options.withCompensation,
    runtimes: options.runtimes,
    hostIsReachable: options.hostIsReachable,
    workspaceIdentity: options.workspaceIdentity,
  });
  const target = (conversationId: string) => resolveTarget(conversationId);
  // MCP servers are fixed when the session materializes, so they only matter at attach.
  const attachTarget = async (conversationId: string) =>
    withProjectMemoryContext(
      options,
      await withConversationMcpServers(options, await target(conversationId))
    );
  const run = <T, E>(
    conversationId: string,
    work: (
      client: ConversationsHostRuntimesClient,
      target: ConversationRuntimeTarget
    ) => Promise<Result<T, E>>
  ) => withConversationRuntime(options, target(conversationId), work);

  // Conversations whose checkpoint failure was already logged; keeps a broken worktree quiet.
  const checkpointWarnings = new Set<string>();
  const readAcpSessionState = async (conversationId: string) => {
    try {
      const source = await resolveConversationRuntimeSource(
        options,
        target(conversationId),
        (client) => client.acp.session.state({ conversationId }, 'state').asLiveSource()
      );
      return (await source.snapshot()).data as SessionState | null;
    } catch {
      return null;
    }
  };
  // Checkpoint refs live in the worktree's repository; deleting a conversation drops its refs.
  const prepareCheckpointCleanup = async (conversationId: string): Promise<() => Promise<void>> => {
    let runtimeTarget: ConversationRuntimeTarget;
    try {
      runtimeTarget = await resolveBaseTarget(conversationId);
    } catch {
      return async () => {};
    }
    return async () => {
      const runtime = await options.runtimes.client(runtimeTarget.host).catch(() => null);
      await deleteConversationCheckpoints(
        runtime?.success ? runtime.data.git : undefined,
        runtimeTarget,
        options.logger,
        checkpointWarnings
      );
    };
  };

  if (options.orchestra) {
    const attachAcp = (conversationId: string) =>
      conversationLifecycleLock.runExclusive(conversationId, async () => {
        const runtimeTarget = await attachTarget(conversationId);
        const input = runtimeTarget.acpInput;
        if (!input) throw missingAcpInputError(runtimeTarget);
        return withConversationRuntime(options, Promise.resolve(runtimeTarget), (client) =>
          client.acp.attach(input)
        );
      });
    // Workers are observed through the same live session models the renderer subscribes to.
    const readSessionState = async (conversationId: string) => {
      const source = await resolveConversationRuntimeSource(
        options,
        target(conversationId),
        (client) => client.acp.session.state({ conversationId }, 'state').asLiveSource()
      );
      return (await source.snapshot()).data as SessionState | null;
    };
    const readSessionConfig = async (conversationId: string) => {
      const source = await resolveConversationRuntimeSource(
        options,
        target(conversationId),
        (client) => client.acp.session.state({ conversationId }, 'config').asLiveSource()
      );
      return (await source.snapshot()).data as SessionConfigState | null;
    };
    // Usage is read on the conductor's host: workers run in the same task, on the same machine.
    const usageFor =
      (usage: UsageLimitsReader) => async (conversationId: string, providerIds: string[]) =>
        usage.peek((await resolveBaseTarget(conversationId)).host, providerIds, USAGE_WAIT_MS);
    const orchestraDeps: OrchestraServiceDeps = {
      dataDirectory: options.orchestra.dataDirectory,
      electronExecutable: options.orchestra.electronExecutable,
      ...(options.orchestra.getSshProxy ? { getSshProxy: options.orchestra.getSshProxy } : {}),
      ...(options.orchestra.agentTools ? { agentTools: options.orchestra.agentTools } : {}),
      ...(options.orchestra.usage ? { providerUsage: usageFor(options.orchestra.usage) } : {}),
      logger: options.logger,
      createConversation: async (params) => {
        const result = await withAttachedProject(options.projects, params.projectId, async () =>
          ok(await conversationOperations.createConversation(params))
        );
        if (!result.success) throw new Error(`Konuşma oluşturulamadı: ${result.error.type}`);
        return result.data;
      },
      // Same verb as the user's delete: kills any live session, then removes the row.
      deleteConversation: ({ projectId, taskId, conversationId }) =>
        conversationOperations.deleteConversation(projectId, taskId, conversationId),
      attach: attachAcp,
      sendPrompt: (input) =>
        run(input.conversationId, (client) => client.acp.sendPrompt(input, { timeoutMs: 0 })),
      cancelTurn: (conversationId) =>
        run(conversationId, (client) => client.acp.cancelTurn({ conversationId })),
      deleteQueuedPrompt: (input) =>
        run(input.conversationId, (client) => client.acp.deleteQueuedPrompt(input)),
      terminate: (conversationId) =>
        run(conversationId, (client) => client.acp.terminate({ conversationId })),
      loadHistory: (conversationId, limit) =>
        run(conversationId, (client) => client.acp.loadHistory({ conversationId, limit })),
      sessionState: async (conversationId) => {
        try {
          const state = await readSessionState(conversationId);
          if (!state) return null;
          return {
            lifecycle: state.lifecycle,
            suspended: state.suspended === true,
            isGenerating: state.isGenerating,
            queuedPromptIds: state.queuedPrompts.map((prompt) => prompt.id),
          };
        } catch {
          return null;
        }
      },
      sessionModel: async (conversationId) => {
        const state = await readSessionState(conversationId);
        // A suspended session presents the configured model, not the one the provider runs.
        if (
          !state ||
          state.suspended ||
          !['ready', 'working', 'cancelling'].includes(state.lifecycle)
        ) {
          throw new Error(`ACP session is not active (${state?.lifecycle ?? 'unknown'})`);
        }
        const models = (await readSessionConfig(conversationId))?.modelOptions;
        if (!models) return null;
        return {
          selected: models.selected,
          available: models.available.map(({ id, name, description }) => ({
            id,
            name,
            ...(description ? { description } : {}),
          })),
        };
      },
      pendingPermissions: async (conversationId) => {
        try {
          const state = await readSessionState(conversationId);
          return (state?.pendingPermissions ?? []) satisfies PendingPermission[];
        } catch {
          return null;
        }
      },
      resolvePermission: (input) =>
        run(input.conversationId, (client) => client.acp.resolvePermission(input)),
      setEffort: async (conversationId, effort) => {
        const runtimeTarget = await target(conversationId);
        const source = await resolveConversationRuntimeSource(
          options,
          Promise.resolve(runtimeTarget),
          (client) => client.acp.session.state({ conversationId }, 'config').asLiveSource()
        );
        const snapshot = await source.snapshot();
        const config = snapshot.data as {
          efforts?: { available: { id: string; name: string }[] } | null;
        } | null;
        const option = pickEffortOption(config?.efforts?.available ?? [], effort);
        if (!option) return null;
        const result = await withConversationRuntime(
          options,
          Promise.resolve(runtimeTarget),
          (client) => client.acp.setOption({ conversationId, key: 'effort', value: option.id })
        );
        if (!result.success) return null;
        // Persist like a manual selection so it survives reconnects.
        await hooks.persistAcpConfigOption(runtimeTarget, 'effort', option.id);
        return option.name;
      },
      setModel: async (conversationId, model) => {
        const runtimeTarget = await target(conversationId);
        const result = await withConversationRuntime(
          options,
          Promise.resolve(runtimeTarget),
          (client) => client.acp.setOption({ conversationId, key: 'model', value: model })
        );
        if (!result.success) return false;
        // Persist the provider's own option id so re-materialization applies the same model.
        await hooks.persistAcpConfigOption(runtimeTarget, 'model', model);
        return true;
      },
    };
    orchestra = new OrchestraService(orchestraDeps);
    // Deterministic workflows reuse the same host functions; no conductor LLM is involved.
    workflows = new WorkflowService({
      dataDirectory: options.orchestra.dataDirectory,
      logger: options.logger,
      createPort: (context) => createWorkflowWorkerPort(orchestraDeps, context),
    });
    const service = orchestra;
    const workflowService = workflows;
    options.orchestra.scope.add(() => service.dispose());
    options.orchestra.scope.add(() => workflowService.dispose());
  }
  const requireWorkflows = (): WorkflowService => {
    if (!workflows) throw new Error('İş akışları bu ortamda kullanılamıyor');
    return workflows;
  };
  const requireOrchestra = (): OrchestraService => {
    if (!orchestra) throw new Error('Orkestra bu ortamda kullanılamıyor');
    return orchestra;
  };

  const acpSessions = forwardLiveModel(conversationsContract.acp.sessions, (key, name) =>
    resolveProjectRuntimeSource(
      options,
      key.projectId,
      Promise.resolve(parseHostRef(key.host)),
      (client) => client.acp.sessions.state(undefined, name).asLiveSource()
    )
  );
  const acpSession = forwardLiveModel(conversationsContract.acp.session, (key, name) =>
    resolveConversationRuntimeSource(options, target(key.conversationId), (client) =>
      client.acp.session.state(key, name).asLiveSource()
    )
  );
  const tuiSessions = forwardLiveModel(conversationsContract.tui.sessions, (key, name) =>
    resolveProjectRuntimeSource(
      options,
      key.projectId,
      Promise.resolve(parseHostRef(key.host)),
      (client) => client.tuiAgents.sessions.state(undefined, name).asLiveSource()
    )
  );

  return createController(conversationsContract, {
    orchestra: {
      register: (input) =>
        withAttachedProject(options.projects, input.projectId, async () =>
          ok(await requireOrchestra().register(input))
        ).then((result) => {
          if (!result.success) throw new Error(`Proje bağlı değil: ${result.error.type}`);
        }),
      get: ({ conversationId }) => orchestra?.get(conversationId) ?? Promise.resolve(null),
      conductorContext: ({ conversationId }) =>
        orchestra?.conductorContext(conversationId) ?? Promise.resolve(null),
    },
    workflows: {
      list: () => requireWorkflows().list(),
      save: ({ workflow }) => requireWorkflows().save(workflow),
      delete: ({ id }) => requireWorkflows().delete(id),
      startRun: async (input) => {
        const attached = await withAttachedProject(options.projects, input.projectId, async () =>
          ok(await requireWorkflows().startRun(input))
        );
        if (!attached.success) {
          return { ok: false as const, errors: [`Proje bağlı değil: ${attached.error.type}`] };
        }
        return attached.data;
      },
      getRun: ({ runId }) => requireWorkflows().getRun(runId),
      listRuns: ({ taskId }) => requireWorkflows().listRuns(taskId),
      cancelRun: ({ runId }) => requireWorkflows().cancelRun(runId),
    },
    attachments: {
      prepareLocalFiles: ({ conversationId, sources }, meta) =>
        run(conversationId, (client, target) =>
          prepareTerminalFiles({
            host: target.host,
            sources,
            localFiles: options.terminalFileSources,
            upload: (file) =>
              client.conversations.attachments.upload({ conversationId }, file, callOptions(meta)),
            remove: (attachmentId) =>
              client.conversations.attachments.delete({ conversationId, attachmentId }),
            signal: meta.signal,
            logger: options.logger,
          })
        ),
      upload: ({ conversationId }, file, meta) =>
        run(conversationId, (client) =>
          client.conversations.attachments.upload({ conversationId }, file, callOptions(meta))
        ),
      download: ({ conversationId, attachmentId }, meta) =>
        openAttachmentDownload(options, target(conversationId), attachmentId, callOptions(meta)),
      delete: ({ conversationId, attachmentId }, meta) =>
        run(conversationId, (client) =>
          client.conversations.attachments.delete(
            { conversationId, attachmentId },
            callOptions(meta)
          )
        ),
    },
    getConversations: () => conversationOperations.getConversations(),
    createConversation: (input) =>
      withAttachedProject(options.projects, input.projectId, async () =>
        ok(await conversationOperations.createConversation(input))
      ),
    deleteConversation: async ({ projectId, taskId, conversationId }) => {
      const cleanup = await prepareCheckpointCleanup(conversationId);
      await conversationOperations.deleteConversation(projectId, taskId, conversationId);
      await cleanup();
    },
    switchView: async ({ conversationId, type, stopUnobservedTerminal }) => {
      const resolved = await target(conversationId);
      requireAttachedProjectOrThrow(options.projects, resolved.projectId);
      return switchConversationView(options, conversationId, type, stopUnobservedTerminal);
    },
    hydrateConversation: ({ projectId, taskId, conversationId, initialSize }) =>
      withAttachedProject(options.projects, projectId, async () => {
        await conversationOperations.hydrateConversation(
          projectId,
          taskId,
          conversationId,
          initialSize
        );
        return ok<void>();
      }),
    dehydrateConversation: ({ projectId, taskId, conversationId }) =>
      withAttachedProject(options.projects, projectId, async () => {
        await conversationOperations.dehydrateConversation(projectId, taskId, conversationId);
        return ok<void>();
      }),
    renameConversation: ({ conversationId, name }) =>
      conversationOperations.renameConversation(conversationId, name),
    getConversationsForTask: ({ projectId, taskId }) =>
      conversationOperations.getConversationsForTask(projectId, taskId),
    getConversationsForProject: ({ projectId }) =>
      conversationOperations.getConversationsForProject(projectId),
    markConversationSeen: ({ conversationId }) =>
      conversationOperations.markConversationSeen(conversationId),
    listHostConversations: (scope) => conversationOperations.listHostConversations(scope),
    linkConversationToTask: (input) => conversationOperations.linkConversationToTask(input),
    deleteHostConversation: async ({ conversationId }) => {
      const cleanup = await prepareCheckpointCleanup(conversationId);
      await conversationOperations.deleteHostConversation(conversationId);
      await cleanup();
    },
    listExternalSessions: ({ limit }) => conversationOperations.listExternalSessions(limit),
    events: conversationWireEvents,
    checkpoints: {
      list: ({ conversationId }, meta) =>
        run(conversationId, (client, runtimeTarget) =>
          withCheckpointSelector(runtimeTarget, (selector) =>
            client.git.checkout.listCheckpoints({ ...selector, conversationId }, callOptions(meta))
          )
        ),
      preview: ({ conversationId, seq }, meta) =>
        run(conversationId, (client, runtimeTarget) =>
          withCheckpointSelector(runtimeTarget, (selector) =>
            client.git.checkout.previewCheckpointRestore(
              { ...selector, conversationId, seq },
              callOptions(meta)
            )
          )
        ),
      restore: ({ conversationId, seq }, meta) =>
        run(conversationId, (client, runtimeTarget) =>
          withCheckpointSelector(runtimeTarget, async (selector) => {
            // A restore rewrites files under a running agent; the renderer also blocks it while
            // a turn is active, but the host never trusts that.
            if ((await readAcpSessionState(conversationId))?.isGenerating) {
              return gitErr.commandFailed(
                'Ajan çalışırken dosyalar geri sarılamaz. Önce durdurun.'
              );
            }
            return client.git.checkout.restoreCheckpoint(
              { ...selector, conversationId, seq },
              callOptions(meta)
            );
          })
        ),
    },
    acp: {
      attach: ({ conversationId }, meta) =>
        conversationLifecycleLock.runExclusive(conversationId, async () => {
          const runtimeTarget = await attachTarget(conversationId);
          const input = runtimeTarget.acpInput;
          if (!input) throw missingAcpInputError(runtimeTarget);
          return withConversationRuntime(options, Promise.resolve(runtimeTarget), (client) =>
            client.acp.attach(input, callOptions(meta))
          );
        }),
      loadHistory: async (input, meta) => {
        const runtimeTarget = await target(input.conversationId);
        return withConversationRuntime(options, Promise.resolve(runtimeTarget), async (client) => {
          const result = await client.acp.loadHistory(input, callOptions(meta));
          await persistActivatedConfiguration(hooks, runtimeTarget, result, options.logger);
          return result;
        });
      },
      terminate: (input, meta) =>
        run(input.conversationId, (client) => client.acp.terminate(input, callOptions(meta))),
      sendPrompt: (input, meta) =>
        run(input.conversationId, async (client, runtimeTarget) => {
          // Kullanıcının gönderdiği prompt: kancalar gözlemsel ve beklemez (içerik yalnızca stdin'e gider).
          emitLifecycleHookEvent({
            name: 'conversation.prompt-submitted',
            projectId: runtimeTarget.projectId,
            taskId: runtimeTarget.taskId,
            conversationId: input.conversationId,
            occurredAt: Date.now(),
            data: { prompt: input.prompt.text },
          });
          // Görev adı hâlâ rastgele yer tutucuysa ilk isteğe göre otomatik konu başlığı ver.
          void autoTitleTaskFromPrompt(
            options.db,
            runtimeTarget.projectId,
            runtimeTarget.taskId,
            input.prompt.text,
            options.generateTaskTitle
          ).catch(() => {});
          // Snapshot the worktree first so this message can be rewound; a failure never blocks it.
          await takePromptCheckpoint(
            client.git,
            runtimeTarget,
            input.promptId,
            options.logger,
            checkpointWarnings,
            meta.signal
          );
          return client.acp.sendPrompt(input, { ...callOptions(meta), timeoutMs: 0 });
        }),
      editQueuedPrompt: (input, meta) =>
        run(input.conversationId, (client) =>
          client.acp.editQueuedPrompt(input, callOptions(meta))
        ),
      deleteQueuedPrompt: (input, meta) =>
        run(input.conversationId, (client) =>
          client.acp.deleteQueuedPrompt(input, callOptions(meta))
        ),
      changeQueuePromptOrder: (input, meta) =>
        run(input.conversationId, (client) =>
          client.acp.changeQueuePromptOrder(input, callOptions(meta))
        ),
      cancelTurn: (input, meta) =>
        run(input.conversationId, (client) => client.acp.cancelTurn(input, callOptions(meta))),
      setOption: async (input, meta) => {
        const runtimeTarget = await target(input.conversationId);
        return withConversationRuntime(options, Promise.resolve(runtimeTarget), async (client) => {
          const result = await client.acp.setOption(input, callOptions(meta));
          if (!result.success) return result;
          try {
            await hooks.persistAcpConfigOption(
              runtimeTarget,
              input.key === 'mode' ? 'modeId' : input.key,
              input.value
            );
            return result;
          } catch (error) {
            return input.key === 'mode'
              ? acpErr.setModeFailed(toSerializedError(error))
              : acpErr.setConfigFailed(toSerializedError(error));
          }
        });
      },
      resolvePermission: (input, meta) =>
        run(input.conversationId, (client) =>
          client.acp.resolvePermission(input, callOptions(meta))
        ),
      exportAcpTranscript: (input, meta) =>
        run(input.conversationId, (client) =>
          client.acp.exportAcpTranscript(input, callOptions(meta))
        ),
      exportRawAcpLog: (input, meta) =>
        run(input.conversationId, (client) => client.acp.exportRawAcpLog(input, callOptions(meta))),
      sessions: acpSessions,
      session: acpSession,
      terminalOutput: async ({ conversationId, terminalId }) =>
        resolveConversationRuntimeSource(options, target(conversationId), (client) =>
          client.acp.terminalOutput.handle({ terminalId }).asLiveSource()
        ),
    },
    tui: {
      start: (input, meta) =>
        run(input.conversationId, (client) => client.tuiAgents.start(input, callOptions(meta))),
      resume: (input, meta) =>
        run(input.conversationId, (client) => client.tuiAgents.resume(input, callOptions(meta))),
      stop: (input, meta) =>
        run(input.conversationId, (client) => client.tuiAgents.stop(input, callOptions(meta))),
      delete: (input, meta) =>
        run(input.conversationId, (client) => client.tuiAgents.delete(input, callOptions(meta))),
      kill: (input, meta) =>
        run(input.conversationId, (client) => client.tuiAgents.kill(input, callOptions(meta))),
      sendInput: async (input, meta) => {
        const runtimeTarget = await target(input.conversationId);
        return withConversationRuntime(options, Promise.resolve(runtimeTarget), async (client) => {
          const result = await client.tuiAgents.sendInput(input, callOptions(meta));
          if (result.success && input.data.includes('\r')) {
            await hooks.recordTuiInput(runtimeTarget);
          }
          return result;
        });
      },
      resize: (input, meta) =>
        run(input.conversationId, (client) => client.tuiAgents.resize(input, callOptions(meta))),
      output: async ({ conversationId }) =>
        resolveConversationRuntimeSource(options, target(conversationId), (client) =>
          client.tuiAgents.output.handle({ conversationId }).asLiveSource()
        ),
      sessions: tuiSessions,
    },
  });
}

function createDefaultRuntimeHooks(
  options: Pick<
    CreateConversationsWireControllerOptions,
    'db' | 'logger' | 'telemetry' | 'runtimes' | 'hostIsReachable'
  >
): ConversationRuntimeHooks {
  const { db, logger, telemetry, runtimes, hostIsReachable } = options;
  return {
    async persistAcpConfigOption(target, key, value) {
      const result = await setConversationAcpConfigOption(
        { db, runtimes, hostIsReachable },
        target.conversationId,
        key,
        value
      );
      if (!result.success) {
        logger.warn('ACP runtime failed to persist selected configuration', {
          conversationId: target.conversationId,
          key,
          error: result.error,
        });
        throw new Error(result.error.message ?? result.error.type);
      }
      if (!result.data.changed || value === null) return;
      if (result.data.taskId === null || result.data.projectId === null) return;
      conversationWireEvents.emit(undefined, {
        type: 'changed',
        conversationId: target.conversationId,
        taskId: result.data.taskId,
        projectId: result.data.projectId,
        changes: { [key]: value },
      });
    },
    // Recency is a host fact now: the runtime's activity report feeds
    // `lastSessionActivityAt` and convergence caches it — only telemetry stays client-side.
    async recordTuiInput(target) {
      if (target.providerId) {
        telemetry.capture('agent_run_started', {
          provider: target.providerId,
          project_id: target.projectId,
          task_id: target.taskId,
          conversation_id: target.conversationId,
        });
      }
    },
  };
}

/**
 * Appends the conversation-scoped MCP servers of every provider to the ACP start input. Servers
 * already present (the orchestra conductor bridge) are never replaced, and a failing provider is
 * logged and skipped so the session still starts.
 */
async function withConversationMcpServers(
  options: Pick<CreateConversationsWireControllerOptions, 'conversationMcpServers' | 'logger'>,
  target: ConversationRuntimeTarget
): Promise<ConversationRuntimeTarget> {
  const input = target.acpInput;
  const providers = options.conversationMcpServers ?? [];
  if (!input || providers.length === 0) return target;
  const current = input.mcpServers ?? [];
  const added = await collectConversationMcpServers({
    providers,
    context: {
      conversationId: target.conversationId,
      projectId: target.projectId,
      taskId: target.taskId,
      workspaceId: target.workspaceId ?? null,
      host: target.host,
    },
    logger: options.logger,
    reserved: current.map((server) => server.name),
  });
  if (added.length === 0) return target;
  return { ...target, acpInput: { ...input, mcpServers: [...current, ...added] } };
}

/**
 * Ayarı açık projelerde, henüz oturumu olmayan sohbetin başlangıç prompt'una "Proje hafızası"
 * dizinini gizli bağlam olarak ekler. Hafıza okunamazsa sohbet bağlamsız başlar.
 */
async function withProjectMemoryContext(
  options: Pick<CreateConversationsWireControllerOptions, 'projectMemory' | 'logger'>,
  target: ConversationRuntimeTarget
): Promise<ConversationRuntimeTarget> {
  const input = target.acpInput;
  const first = input?.initialQueue?.[0];
  if (!input || !first || !options.projectMemory) return target;
  const context = await options.projectMemory.promptContext(target.projectId).catch((error) => {
    options.logger.warn('Proje hafızası bağlamı okunamadı', { error: String(error) });
    return null;
  });
  if (!context) return target;
  const initialQueue = [
    { ...first, hiddenContext: [context, first.hiddenContext].filter(Boolean).join('\n\n') },
    ...(input.initialQueue ?? []).slice(1),
  ];
  return { ...target, acpInput: { ...input, initialQueue } };
}

function missingAcpInputError(target: ConversationRuntimeTarget): Error {
  if (target.conversationType === 'acp' && !target.workspacePath) {
    return new Error(
      `Workspace for conversation '${target.conversationId}' is not provisioned yet`
    );
  }
  return new Error(`Conversation '${target.conversationId}' is not an ACP conversation`);
}

async function resolveConversationRuntimeTarget(
  conversationId: string,
  workspaceIdentity: WorkspaceIdentityResolver,
  db: AppDb,
  getProviderEnv: ((providerId: string) => Promise<Record<string, string> | undefined>) | undefined,
  sessionLaunchContexts: Pick<TaskSessionLaunchContextResolver, 'resolve'>
): Promise<ConversationRuntimeTarget> {
  const [row] = await db
    .select({
      projectId: conversations.projectId,
      taskId: conversations.taskId,
      providerId: conversations.provider,
      sessionId: conversations.providerSessionId,
      cwd: conversations.cwd,
      config: conversations.config,
      type: conversations.type,
      workspaceId: tasks.workspaceId,
    })
    .from(conversations)
    .leftJoin(
      tasks,
      and(eq(tasks.id, conversations.taskId), eq(tasks.projectId, conversations.projectId))
    )
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row) throw new Error(`Conversation '${conversationId}' was not found`);
  if (row.projectId === null || row.taskId === null) {
    // Sessions run inside task surfaces; unlinked mirror rows have no runtime target.
    throw new Error(`Conversation '${conversationId}' has no task link`);
  }

  const identity = row.workspaceId ? await workspaceIdentity.resolve(row.workspaceId) : null;
  const acpConfig = row.config?.type === 'acp' ? row.config : undefined;
  const initialQueue =
    row.sessionId === null
      ? acpConfig?.initialQueue?.length
        ? acpConfig.initialQueue
        : acpConfig?.initialPrompt?.trim()
          ? [{ text: acpConfig.initialPrompt }]
          : undefined
      : undefined;
  const workspacePath = identity?.path;
  const acpCwd = row.sessionId && row.cwd ? row.cwd : workspacePath;
  // Resolve the ACP agent environment in main from provider and project/task settings. The
  // renderer supplies only a conversation id and cannot inject spawn variables.
  const [providerEnv, launchContext] = await Promise.all([
    row.providerId && getProviderEnv ? getProviderEnv(row.providerId) : undefined,
    row.type === 'acp' && workspacePath
      ? sessionLaunchContexts.resolve({
          projectId: row.projectId,
          taskId: row.taskId,
          ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
        })
      : undefined,
  ]);
  if (launchContext && !launchContext.success) {
    throw new Error(`Could not resolve task session launch context: ${launchContext.error.type}`);
  }
  const processEnv = {
    ...(providerEnv ?? {}),
    ...(launchContext?.success ? launchContext.data.env : {}),
  };
  const acpInput =
    row.type === 'acp' && acpCwd && row.providerId
      ? {
          conversationId,
          providerId: row.providerId,
          cwd: acpCwd,
          sessionId: row.sessionId,
          model: acpConfig?.model ?? null,
          modeId: acpConfig?.modeId ?? null,
          effort: acpConfig?.effort ?? null,
          collaborationMode: acpConfig?.collaborationMode ?? null,
          ...(initialQueue && { initialQueue }),
          ...(Object.keys(processEnv).length > 0 ? { env: processEnv } : {}),
        }
      : undefined;

  return {
    conversationId,
    projectId: row.projectId,
    taskId: row.taskId,
    conversationType: row.type === 'acp' ? 'acp' : 'pty',
    providerId: row.providerId,
    sessionId: row.sessionId,
    model: acpConfig?.model ?? null,
    modeId: acpConfig?.modeId ?? null,
    effort: acpConfig?.effort ?? null,
    collaborationMode: acpConfig?.collaborationMode ?? null,
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    workspacePath,
    host: identity?.host ?? LOCAL_HOST_REF,
    acpInput,
  };
}

async function withConversationRuntime<T, E>(
  options: Pick<CreateConversationsWireControllerOptions, 'projects' | 'runtimes'>,
  targetPromise: Promise<ConversationRuntimeTarget>,
  work: (
    client: ConversationsHostRuntimesClient,
    target: ConversationRuntimeTarget
  ) => Promise<Result<T, E>>
): Promise<Result<T, E | RuntimeResolveError | ProjectAttachmentError>> {
  const target = await targetPromise;
  assertConversationNotSwitching(target.conversationId);
  return withAttachedProject(options.projects, target.projectId, async () => {
    const result = await options.runtimes.client(target.host);
    if (!result.success) return err(result.error);
    assertConversationNotSwitching(target.conversationId);
    return await work(result.data, target);
  });
}

function callOptions(meta: CallMeta): { signal?: AbortSignal } {
  return meta.signal ? { signal: meta.signal } : {};
}

/**
 * Mirrors activation's configuration decisions into host config: unsupported selections are
 * cleared, and selections applied under the provider's own option id (a catalog model such as
 * `claude-sonnet-5-5` running as Claude's `sonnet`) are stored as that id.
 */
async function persistActivatedConfiguration(
  hooks: ConversationRuntimeHooks,
  target: ConversationRuntimeTarget,
  result: Result<
    {
      clearedConfiguration?: Array<'model' | 'modeId' | 'effort' | 'collaborationMode'>;
      resolvedConfiguration?: ResolvedConfiguration;
    },
    unknown
  >,
  logger: Logger
): Promise<void> {
  if (!result.success) return;
  for (const key of result.data.clearedConfiguration ?? []) {
    try {
      await hooks.persistAcpConfigOption(target, key, null);
    } catch (error) {
      logger.warn('ACP runtime failed to clear unsupported stored configuration', {
        conversationId: target.conversationId,
        key,
        error: String(error),
      });
    }
  }
  const resolved = result.data.resolvedConfiguration ?? {};
  for (const key of ['model', 'effort', 'collaborationMode'] as const) {
    const value = resolved[key];
    if (!value) continue;
    try {
      await hooks.persistAcpConfigOption(target, key, value);
    } catch (error) {
      logger.warn('ACP runtime failed to store resolved configuration', {
        conversationId: target.conversationId,
        key,
        error: String(error),
      });
    }
  }
}

async function resolveConversationRuntimeSource(
  options: Pick<CreateConversationsWireControllerOptions, 'projects' | 'runtimes'>,
  targetPromise: Promise<ConversationRuntimeTarget>,
  source: (client: ConversationsHostRuntimesClient) => LiveSource
): Promise<LiveSource> {
  const target = await targetPromise;
  return resolveProjectRuntimeSource(
    options,
    target.projectId,
    Promise.resolve(target.host),
    source
  );
}

async function resolveProjectRuntimeSource(
  options: Pick<CreateConversationsWireControllerOptions, 'projects' | 'runtimes'>,
  projectId: string,
  hostPromise: Promise<HostRef>,
  source: (client: ConversationsHostRuntimesClient) => LiveSource
): Promise<LiveSource> {
  requireAttachedProjectOrThrow(options.projects, projectId);
  return resolveRuntimeSource(options.runtimes, hostPromise, source);
}

async function resolveRuntimeSource(
  runtimes: ConversationsRuntimeBroker,
  hostPromise: Promise<HostRef>,
  source: (client: ConversationsHostRuntimesClient) => LiveSource
): Promise<LiveSource> {
  const result = await runtimes.client(await hostPromise);
  if (!result.success) throwConversationsRuntimeResolveError(result.error);
  return source(result.data);
}

async function openAttachmentDownload(
  options: Pick<CreateConversationsWireControllerOptions, 'projects' | 'runtimes'>,
  targetPromise: Promise<ConversationRuntimeTarget>,
  attachmentId: string,
  call: { signal?: AbortSignal }
) {
  const target = await targetPromise;
  return withAttachedProject(options.projects, target.projectId, async () => {
    const runtime = await options.runtimes.client(target.host);
    if (!runtime.success) return err(runtime.error);
    const result = await runtime.data.conversations.attachments.download(
      { conversationId: target.conversationId, attachmentId },
      call
    );
    if (!result.success) return result;
    return {
      success: true as const,
      data: { meta: result.data.meta, source: result.data.chunks() },
    };
  });
}
