import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { createSubagentRouter, resolveSubagentRoutingFile } from '@orkestra/core/runtimes/acp/node';
import type { RuntimeBroker } from '@orkestra/core/services/runtime-broker/api';
import type { Scope } from '@orkestra/shared/concurrency';
import type { Logger } from '@orkestra/shared/logger';
import {
  createController,
  forwardController,
  type Contract,
  type ContractDefinitions,
  type ContractImpl,
  type Controller,
} from '@orkestra/wire/rpc';
import { app, shell } from 'electron';
import type { OrkestraAccountService } from '@core/features/account/node/services/orkestra-account-service';
import { createAccountWireController } from '@core/features/account/node/wire-controller';
import { createAgentOperations } from '@core/features/agents/node/controller';
import { createAgentsWireController } from '@core/features/agents/node/wire-controller';
import { ArtifactShareServer } from '@core/features/artifact-shares/node/artifact-share-server';
import { createArtifactSharesWireController } from '@core/features/artifact-shares/node/wire-controller';
import type { AtlasService } from '@core/features/atlas/node/atlas-service';
import { createAtlasWireController } from '@core/features/atlas/node/wire-controller';
import type { AutomationsService } from '@core/features/automations/api/node/automations-service';
import type { AutomationWebhookServer } from '@core/features/automations/node/webhook-server';
import { createAutomationsWireController } from '@core/features/automations/node/wire-controller';
import {
  createBrowserWireController,
  type BrowserOperations,
} from '@core/features/browser/node/wire-controller';
import { createCatalogWireController } from '@core/features/catalog/node/wire-controller';
import {
  createChromeWireController,
  type ChromeOperations,
} from '@core/features/chrome/node/wire-controller';
import {
  createComputerUseWireController,
  type ComputerUseControllerDeps,
} from '@core/features/computer-use/node/wire-controller';
import type { CompensationRunner } from '@core/features/conversations/node/createConversation';
import { createConversationsWireController } from '@core/features/conversations/node/wire-controller';
import {
  createDevPerfWireController,
  type DevPerfOperations,
} from '@core/features/dev-perf/node/wire-controller';
import type { EditorBufferService } from '@core/features/editor/node/editor-buffer-service';
import { createEditorWireController } from '@core/features/editor/node/wire-controller';
import { createFilesWireController } from '@core/features/files/node/wire-controller';
import type { GitCredentialsService } from '@core/features/github/api/node/services/git-credentials-service';
import { createGithubWireController } from '@core/features/github/node/wire-controller';
import { createIntegrationsWireController } from '@core/features/integrations/node/wire-controller';
import { listIssues } from '@core/features/issues/node/operations';
import type { IssueProviderRegistry } from '@core/features/issues/node/registry';
import { createIssuesWireController } from '@core/features/issues/node/wire-controller';
import {
  createLegacyPortWireController,
  type LegacyPortControllerOperations,
} from '@core/features/legacy-port/node/wire-controller';
import type { PromptLibraryService } from '@core/features/library/node/prompt-library-service';
import { createPromptLibraryWireController } from '@core/features/library/node/wire-controller';
import { createLocalHookProcessRunner } from '@core/features/lifecycle-hooks/node/hook-process-runner';
import {
  LifecycleHooksService,
  type LifecycleHooksContextHost,
} from '@core/features/lifecycle-hooks/node/lifecycle-hooks-service';
import { isLocalProject } from '@core/features/lifecycle-hooks/node/local-project';
import { createLifecycleHooksWireController } from '@core/features/lifecycle-hooks/node/wire-controller';
import {
  LogHealthService,
  type LogHealthHost,
} from '@core/features/log-health/node/log-health-service';
import { createLogHealthWireController } from '@core/features/log-health/node/wire-controller';
import { createMachinesWireController } from '@core/features/machines/node/wire-controller';
import { createDesktopMcpAppsService } from '@core/features/mcp-apps/node/desktop-mcp-apps';
import { createMcpAppsWireController } from '@core/features/mcp-apps/node/wire-controller';
import { createMcpWireController } from '@core/features/mcp/node/wire-controller';
import type { OutsideAgentsService } from '@core/features/outside-agents/node/outside-agents-service';
import { createOutsideAgentsWireController } from '@core/features/outside-agents/node/wire-controller';
import { createPluginPacksWireController } from '@core/features/plugin-packs/node/wire-controller';
import type { PreviewServerAccessOperations } from '@core/features/preview-servers/node/preview-server-access-service';
import { createPreviewServersWireController } from '@core/features/preview-servers/node/wire-controller';
import type { ProjectMemoryService } from '@core/features/project-memory/node/project-memory-service';
import { createProjectMemoryWireController } from '@core/features/project-memory/node/wire-controller';
import { ProjectRepositoriesService } from '@core/features/project-repositories/api/node/project-repositories-service';
import { createProjectRepositoriesWireController } from '@core/features/project-repositories/node/wire-controller';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import type { ProjectSettingsService } from '@core/features/projects/api/node/settings/project-settings-service';
import type { ProjectDeletionDependencies } from '@core/features/projects/node/operations/deleteProject';
import { getProjectById } from '@core/features/projects/node/operations/getProjects';
import { createProjectsWireController } from '@core/features/projects/node/wire-controller';
import type { RemoteAccessService } from '@core/features/remote-access/node/remote-access-service';
import { createRemoteAccessWireController } from '@core/features/remote-access/node/remote-access-wire-controller';
import { createRepositoryWireController } from '@core/features/repository/node/wire-controller';
import type { SearchService } from '@core/features/search/node/search-service';
import { createSearchWireController } from '@core/features/search/node/wire-controller';
import { sharedOnePasswordResolver } from '@core/features/secrets/node/onepassword-resolver';
import { createSecretsWireController } from '@core/features/secrets/node/wire-controller';
import { SimulatorService } from '@core/features/simulator/node/simctl';
import { createSimulatorWireController } from '@core/features/simulator/node/wire-controller';
import { createSkillsWireController } from '@core/features/skills/node/wire-controller';
import type { SnapshotService } from '@core/features/snapshot/node/snapshot-service';
import { createSnapshotWireController } from '@core/features/snapshot/node/wire-controller';
import { createSourceControlWireController } from '@core/features/source-control/node/wire-controller';
import { SubagentRoutingSync } from '@core/features/subagent-routing/node/routing-sync';
import { createSubagentRoutingWireController } from '@core/features/subagent-routing/node/wire-controller';
import type { TaskService } from '@core/features/tasks/api/node/task-service';
import type { TaskSessionLaunchContextResolver } from '@core/features/tasks/api/node/task-session-launch-context';
import type { TaskSessionManager } from '@core/features/tasks/api/node/task-session-manager';
import { TaskListService } from '@core/features/tasks/node/task-list-service';
import { createTasksWireController } from '@core/features/tasks/node/wire-controller';
import { createTelemetryWireController } from '@core/features/telemetry/node/wire-controller';
import {
  createTerminalsWireController,
  type CreateTerminalsWireControllerOptions,
} from '@core/features/terminals/node/wire-controller';
import type { TextGenerationService } from '@core/features/text-generation/node/text-generation-service';
import { createTextGenerationWireController } from '@core/features/text-generation/node/wire-controller';
import {
  createUpdatesWireController,
  type UpdateOperations,
} from '@core/features/updates/node/wire-controller';
import {
  createUsageLimitsWireController,
  usageLedgerServiceFor,
  usageLimitsServiceFor,
} from '@core/features/usage-limits/node/wire-controller';
import {
  createVoiceWireController,
  type VoiceOperations,
} from '@core/features/voice/node/wire-controller';
import {
  createDesktopHostWireController,
  type DesktopHostControllerOperations,
} from '@core/features/workbench/node/wire-controller';
import { createDesktopCodeWorkflowsHost } from '@core/features/workflows/api/node/host-wiring';
import type { WorkspacePlacementResolver } from '@core/features/workspaces/api/node/placement/workspace-placement-resolver';
import { createWorkspaceRegistry } from '@core/features/workspaces/api/node/registry';
import type { WorkspaceIdentityService } from '@core/features/workspaces/api/node/workspace-identity-service';
import { createLifecycleScriptsWireController } from '@core/features/workspaces/node/lifecycle-scripts-wire-controller';
import {
  createProjectSettingsWireController,
  createProjectWorkspacesWireController,
} from '@core/features/workspaces/node/project-wire-controllers';
import { createWorkspaceRegistryWireController } from '@core/features/workspaces/node/registry-wire-controller';
import {
  createWorkspacesWireController,
  type CreateWorkspacesWireControllerOptions,
} from '@core/features/workspaces/node/wire-controller';
import { WorkspaceMutationService } from '@core/features/workspaces/node/workspace-mutation-service';
import type { SshServiceHandle } from '@core/manifests/node/ssh-service-handle';
import { desktopDomainContracts } from '@core/manifests/shared/domain-contracts';
import { resolveProviderRuntimeEnv } from '@core/primitives/app-settings/api';
import type { HostReachabilityProbe } from '@core/primitives/ssh/api';
import type { TelemetryService } from '@core/primitives/telemetry/api/telemetry';
import type { ConversationMcpServerProvider } from '@core/services/agent-tools/api/agent-tools';
import type { AgentToolsBridgeHost } from '@core/services/agent-tools/node/agent-tools-host';
import type { AppDb } from '@core/services/app-db/node/db';
import type { TerminalFileSources } from '@core/services/attachments/node/prepare-terminal-files';
import type { HostAvailabilityService } from '@core/services/hosts/node/availability';
import type { Hosts } from '@core/services/hosts/node/hosts';
import { createHostMaintenanceWireController } from '@core/services/hosts/node/maintenance-wire-controller';
import { createHostsWireController } from '@core/services/hosts/node/wire-controller';
import {
  createLoggingWireController,
  type LoggingControllerOperations,
} from '@core/services/logging/node/wire-controller';
import type { NotificationService } from '@core/services/notifications/node';
import { createNotificationsWireController } from '@core/services/notifications/node/wire-controller';
import type { PullRequestsRuntimeClient } from '@core/services/pull-requests/api';
import type { ReconcileSweepHandle } from '@core/services/reconcile-sweep/node/reconcile-sweep-service';
import type { MementosRuntimeClient } from '@core/services/runtime-broker/api/clients';
import { hostSettingsDefaults } from '@core/services/runtime-broker/node/host-settings';
import type { AppSettingsService } from '@core/services/settings/node';
import type { ProviderOverrideSettings } from '@core/services/settings/node/provider-settings-service';
import {
  createAppSettingsWireController,
  type SettingsRuntimePort,
} from '@core/services/settings/node/wire-controller';
import { createSshWireController } from '@core/services/ssh/node/controller';

export type DesktopControllerContext = {
  readonly accountService: OrkestraAccountService;
  /** Shared plumbing of Orkestra's agent tool servers (conductor and in-app browser). */
  readonly agentTools: AgentToolsBridgeHost;
  readonly agentDependencies: Omit<
    Parameters<typeof createAgentOperations>[0],
    'providerOverrideSettings'
  >;
  readonly appSettings: AppSettingsService;
  readonly automations: AutomationsService;
  readonly automationWebhooks: AutomationWebhookServer;
  readonly browserOperations: BrowserOperations;
  readonly chromeOperations: ChromeOperations;
  readonly compensation: CompensationRunner;
  /** MCP servers added to every ACP conversation (the in-app browser tools). */
  readonly conversationMcpServers: readonly ConversationMcpServerProvider[];
  readonly db: AppDb;
  readonly devPerfOperations: DevPerfOperations;
  readonly editorBuffer: EditorBufferService;
  readonly github: Omit<Parameters<typeof createGithubWireController>[0], 'logger'>;
  readonly gitCredentials: GitCredentialsService;
  readonly computerUse: ComputerUseControllerDeps;
  readonly hostAvailability: HostAvailabilityService;
  readonly hostIsReachable: HostReachabilityProbe;
  readonly hostOperations: DesktopHostControllerOperations;
  readonly issueProviders: IssueProviderRegistry;
  readonly legacyPortOperations: LegacyPortControllerOperations;
  /** Kancalar: userData dizini, şifreli secret deposu ve kullanıcı kabuk env'i. */
  readonly lifecycleHooksHost: LifecycleHooksContextHost;
  readonly logger: Logger;
  readonly loggingOperations: LoggingControllerOperations;
  /** Günlük sağlığı servisinin dosya yolu ve Finder erişimi. */
  readonly logHealthHost: LogHealthHost;
  readonly notifications: NotificationService;
  readonly previewServerAccess: PreviewServerAccessOperations;
  readonly projectDeletion: ProjectDeletionDependencies;
  /** Proje başına ortak ajan hafızası (ayar, kayıtlar, ilk prompt dizini). */
  readonly projectMemory: ProjectMemoryService;
  /** Atlas bağlantısı (arama kaynağı ve oturum kartları). */
  readonly atlas: AtlasService;
  readonly promptLibrary: PromptLibraryService;
  readonly projects: ProjectAttachmentManager;
  readonly projectSettings: ProjectSettingsService;
  readonly providerSettings: ProviderOverrideSettings;
  readonly reconcileSweep: ReconcileSweepHandle;
  /** Mobil uzak erişim geçidi (varsayılan kapalı); gateway açılışında başlatılır. */
  readonly remoteAccess: RemoteAccessService;
  /** Dış ajanlar için yerel MCP sunucusu (varsayılan kapalı); gateway açılışında başlatılır. */
  readonly outsideAgents: OutsideAgentsService;
  readonly hosts: Hosts;
  readonly runtimeClients: {
    getMementosRuntimeClient(): Promise<MementosRuntimeClient>;
    getPullRequestsRuntimeClient(): Promise<PullRequestsRuntimeClient>;
  };
  readonly scope: Scope;
  readonly search: SearchService;
  readonly sessionLaunchContexts: TaskSessionLaunchContextResolver;
  readonly snapshot: SnapshotService;
  readonly runtimes: RuntimeBroker;
  readonly ssh: SshServiceHandle;
  readonly settingsRuntime: SettingsRuntimePort;
  readonly telemetry: TelemetryService;
  readonly textGeneration: TextGenerationService;
  readonly taskService: TaskService;
  readonly taskSessions: TaskSessionManager;
  readonly terminalFileSources: TerminalFileSources;
  readonly terminalShell: CreateTerminalsWireControllerOptions['terminalShell'];
  readonly updateOperations: UpdateOperations;
  /** ElevenLabs dikte ve sesli yanıt işlemleri (anahtar ana süreçte kalır). */
  readonly voiceOperations: VoiceOperations;
  readonly workspaceIdentity: WorkspaceIdentityService;
  readonly workspacePlacement: WorkspacePlacementResolver;
  readonly workspaces: Omit<CreateWorkspacesWireControllerOptions, 'db' | 'mutations'>;
};

type DesktopDomain = Extract<keyof typeof desktopDomainContracts, string>;

export type DesktopNodeControllerContribution = {
  readonly create: (context: DesktopControllerContext) => Controller | Promise<Controller>;
};

function controllerFromImpl<Defs extends ContractDefinitions>(
  contract: Contract<Defs>,
  owner: { impl: ContractImpl<Defs>; dispose(): Promise<void> },
  scope: Scope
): Controller {
  scope.add(() => owner.dispose());
  return createController(contract, owner.impl);
}

export const desktopNodeControllers = {
  account: {
    create: ({ accountService, logger, telemetry }) =>
      createAccountWireController(accountService, { logger, telemetry }),
  },
  agents: {
    create: ({ agentDependencies, providerSettings, runtimes }) =>
      createAgentsWireController({
        operations: createAgentOperations({
          ...agentDependencies,
          providerOverrideSettings: providerSettings,
        }),
        runtimes,
      }),
  },
  appSettings: {
    create: ({ appSettings, settingsRuntime }) =>
      createAppSettingsWireController(appSettings, settingsRuntime),
  },
  computerUse: {
    create: ({ computerUse }) => createComputerUseWireController(computerUse),
  },
  devPerf: {
    create: ({ devPerfOperations, logger }) =>
      createDevPerfWireController(devPerfOperations, logger),
  },
  editor: {
    create: ({ editorBuffer }) => createEditorWireController({ editorBuffer }),
  },
  files: {
    create: ({ runtimes }) => createFilesWireController({ runtimes }),
  },
  legacyPort: {
    create: ({ legacyPortOperations }) => createLegacyPortWireController(legacyPortOperations),
  },
  logging: {
    create: ({ loggingOperations }) => createLoggingWireController(loggingOperations),
  },
  lifecycleHooks: {
    create: async ({ db, lifecycleHooksHost, logger, runtimes, scope }) => {
      const service = new LifecycleHooksService(
        {
          ...lifecycleHooksHost,
          isLocalProject: (projectId) => isLocalProject(db, projectId),
          resolveShellSetup: async () => {
            const local = await runtimes.client(LOCAL_HOST_REF);
            if (!local.success) return undefined;
            return (await hostSettingsDefaults(local.data.hostSettings)).shellSetup;
          },
          runner: createLocalHookProcessRunner(),
        },
        logger
      );
      await service.start();
      scope.add(() => service.dispose());
      return createLifecycleHooksWireController(service);
    },
  },
  logHealth: {
    create: ({ logger, logHealthHost, scope }) => {
      const service = new LogHealthService({ host: logHealthHost, logger });
      scope.add(() => service.dispose());
      service.start();
      return createLogHealthWireController(service);
    },
  },
  machines: {
    create: ({ runtimes, ssh }) => createMachinesWireController(ssh.machines, runtimes),
  },
  projectMemory: {
    create: ({ projectMemory }) => createProjectMemoryWireController(projectMemory),
  },
  atlas: {
    create: ({ atlas }) => createAtlasWireController(atlas),
  },
  projectRepositories: {
    create: ({ runtimes, workspaceIdentity }) =>
      createProjectRepositoriesWireController(
        new ProjectRepositoriesService({ runtimes, workspaceIdentity })
      ),
  },
  projectSettings: {
    create: ({ runtimes, workspaceIdentity }) =>
      createProjectSettingsWireController({ runtimes, workspaceIdentity }),
  },
  projectWorkspaces: {
    create: ({ db, projects, runtimes, scope, taskService, taskSessions }) => {
      const controller = createProjectWorkspacesWireController({
        db,
        projects,
        runtimes,
        taskService,
        taskSessions,
      });
      scope.add(() => controller.dispose());
      return controller.controller;
    },
  },
  promptLibrary: {
    create: ({ promptLibrary }) => createPromptLibraryWireController(promptLibrary),
  },
  pluginPacks: {
    create: ({ promptLibrary, runtimes }) =>
      createPluginPacksWireController({
        runtimes,
        userDataDir: app.getPath('userData'),
        prompts: {
          get: () => promptLibrary.getPrompts(),
          set: (prompts) => promptLibrary.updatePrompts(prompts),
        },
      }),
  },
  repository: {
    create: ({ db, projects }) =>
      createRepositoryWireController({
        projects,
        loadProject: (projectId) => getProjectById(db, projectId),
      }),
  },
  search: {
    create: ({ search }) => createSearchWireController(search),
  },
  secrets: {
    create: () => createSecretsWireController(sharedOnePasswordResolver),
  },
  telemetry: {
    create: ({ telemetry }) => createTelemetryWireController(telemetry),
  },
  sourceControl: {
    create: ({ gitCredentials, runtimes, workspaceIdentity, projects }) =>
      createSourceControlWireController({
        runtimes,
        workspaceIdentity,
        projects,
        mintOperationCredentials: gitCredentials.mintOperationCredentials,
      }),
  },
  mcp: {
    create: ({ runtimes }) => createMcpWireController({ runtimes }),
  },
  mcpApps: {
    create: ({ appSettings, logger, runtimes, scope }) =>
      createMcpAppsWireController(
        createDesktopMcpAppsService({
          appSettings,
          logger,
          runtimes,
          scope,
          userDataDirectory: app.getPath('userData'),
          version: app.getVersion(),
        })
      ),
  },
  skills: {
    create: ({ runtimes }) => createSkillsWireController({ runtimes }),
  },
  simulator: {
    create: () => createSimulatorWireController(new SimulatorService()),
  },
  snapshot: {
    create: ({ snapshot }) => createSnapshotWireController(snapshot),
  },
  terminals: {
    create: ({
      appSettings,
      db,
      terminalFileSources,
      gitCredentials,
      logger,
      projects,
      runtimes,
      sessionLaunchContexts,
      telemetry,
      terminalShell,
      workspaceIdentity,
    }) =>
      createTerminalsWireController({
        terminalFileSources,
        db,
        projects,
        runtimes,
        sessionLaunchContexts,
        settings: appSettings,
        logger,
        telemetry,
        terminalShell,
        workspaceIdentity,
        resolveSessionGitCredentials: gitCredentials.resolveSessionSpec,
      }),
  },
  mementos: {
    create: async ({ runtimeClients }) =>
      forwardController(
        desktopDomainContracts.mementos,
        await runtimeClients.getMementosRuntimeClient()
      ),
  },
  notifications: {
    create: ({ notifications }) => createNotificationsWireController(notifications),
  },
  pullRequests: {
    create: async ({ runtimeClients }) =>
      forwardController(
        desktopDomainContracts.pullRequests,
        await runtimeClients.getPullRequestsRuntimeClient()
      ),
  },
  catalog: {
    create: ({ scope }) =>
      controllerFromImpl(desktopDomainContracts.catalog, createCatalogWireController(), scope),
  },
  workspaces: {
    create: ({ db, projects, runtimes, scope, workspaces }) => {
      const mutations = new WorkspaceMutationService({ db, projects, runtimes });
      return controllerFromImpl(
        desktopDomainContracts.workspaces,
        createWorkspacesWireController({
          ...workspaces,
          db,
          mutations,
        }),
        scope
      );
    },
  },
  workspaceRegistry: {
    create: ({ db, reconcileSweep, runtimes }) =>
      createWorkspaceRegistryWireController({ db, runtimes, sweep: reconcileSweep }),
  },
  lifecycleScripts: {
    create: ({ runtimes, workspaceIdentity }) =>
      createLifecycleScriptsWireController({ runtimes, workspaceIdentity }),
  },
  projects: {
    create: ({
      db,
      gitCredentials,
      projectDeletion,
      projects,
      projectSettings,
      runtimes,
      scope,
      workspacePlacement,
    }) =>
      controllerFromImpl(
        desktopDomainContracts.projects,
        createProjectsWireController({
          db,
          placement: workspacePlacement,
          projectDeletion,
          projects,
          projectSettings,
          runtimes,
          mintCloneCredentials: gitCredentials.mintCloneCredentials,
        }),
        scope
      ),
  },
  automations: {
    create: ({ automations, automationWebhooks, db, logger, runtimes, taskService }) =>
      createAutomationsWireController({
        db,
        getProjectById: (projectId) => getProjectById(db, projectId),
        logger,
        runtime: {
          runtimes,
          getProjectById: (projectId) => getProjectById(db, projectId),
        },
        service: automations,
        taskService,
        webhookServer: automationWebhooks,
      }),
  },
  browser: {
    create: ({ browserOperations }) => createBrowserWireController(browserOperations),
  },
  chrome: {
    create: ({ chromeOperations }) => createChromeWireController(chromeOperations),
  },
  conversations: {
    create: ({
      agentTools,
      appSettings,
      automationWebhooks,
      issueProviders,
      notifications,
      runtimeClients,
      compensation,
      conversationMcpServers,
      scope,
      db,
      terminalFileSources,
      hostIsReachable,
      logger,
      projects,
      projectMemory,
      providerSettings,
      runtimes,
      search,
      sessionLaunchContexts,
      ssh,
      taskSessions,
      telemetry,
      textGeneration,
      workspaceIdentity,
    }) =>
      createConversationsWireController({
        terminalFileSources,
        db,
        logger,
        projects,
        getProviderEnv: async (providerId) => {
          const baseEnv = resolveProviderRuntimeEnv(
            providerId,
            await providerSettings.getItem(providerId)
          );
          if (!baseEnv) return undefined;
          const secretsSettings = await appSettings.get('secrets');
          return sharedOnePasswordResolver.resolveEnvSecrets(baseEnv, {
            enabled: secretsSettings.onePasswordEnabled,
            account: secretsSettings.onePasswordAccount,
            warn: (msg, ctx) => logger.warn(msg, ctx),
          });
        },
        generateTaskTitle: (prompt) => textGeneration.generateTaskTitle(prompt),
        sessionLaunchContexts,
        runtimes,
        taskSessions,
        telemetry,
        workspaceIdentity,
        withCompensation: compensation,
        hostIsReachable,
        orchestra: {
          dataDirectory: app.getPath('userData'),
          electronExecutable: process.execPath,
          scope,
          getSshProxy: (connectionId) => ssh.manager.getProxy(connectionId),
          agentTools,
          usage: usageLimitsServiceFor({ runtimes, providerSettings }),
        },
        conversationMcpServers,
        codeWorkflows: createDesktopCodeWorkflowsHost({
          appSettings,
          hooks: automationWebhooks,
          notifications,
          listIssues: (provider, issueOptions) =>
            listIssues({ projects, providers: issueProviders }, provider, issueOptions),
          projects,
          getPullRequestsClient: () => runtimeClients.getPullRequestsRuntimeClient(),
          openPath: (path) => shell.openPath(path),
        }),
        projectMemory,
        onIndexConversationMessages: (input) => search.indexConversationMessages(input),
        onAppendConversationMessage: (input) => search.appendConversationMessage(input),
        onRecordTurnUsage: (entry) => {
          usageLedgerServiceFor(db).record({ ...entry, turnsDelta: 1 });
        },
      }),
  },
  artifactShares: {
    create: ({ scope }) => createArtifactSharesWireController(new ArtifactShareServer(), scope),
  },
  previewServers: {
    create: ({ previewServerAccess }) => createPreviewServersWireController(previewServerAccess),
  },
  github: {
    create: ({ github, logger }) => createGithubWireController({ ...github, logger }),
  },
  integrations: {
    create: () => createIntegrationsWireController(),
  },
  issues: {
    create: ({ issueProviders, projects }) =>
      createIssuesWireController({ projects, providers: issueProviders }),
  },
  ssh: {
    create: ({ ssh }) => createSshWireController(ssh.ssh, ssh.connections),
  },
  hosts: {
    create: ({ hostAvailability, hosts, ssh }) =>
      createHostsWireController(hosts, hostAvailability, ssh.ssh),
  },
  hostMaintenance: {
    create: ({ hosts }) => createHostMaintenanceWireController(hosts),
  },
  tasks: {
    create: ({ db, scope, taskService, taskSessions, telemetry }) => {
      const taskList = new TaskListService({
        taskService,
        taskSessions,
        workspaces: createWorkspaceRegistry(db),
      });
      return controllerFromImpl(
        desktopDomainContracts.tasks,
        createTasksWireController({
          db,
          service: taskService,
          taskList,
          telemetry,
        }),
        scope
      );
    },
  },
  updates: {
    create: ({ updateOperations }) => createUpdatesWireController(updateOperations),
  },
  textGeneration: {
    create: ({ textGeneration }) => createTextGenerationWireController(textGeneration),
  },
  usageLimits: {
    create: ({ db, providerSettings, runtimes }) =>
      createUsageLimitsWireController(
        usageLimitsServiceFor({ runtimes, providerSettings }),
        usageLedgerServiceFor(db)
      ),
  },
  subagentRouting: {
    create: ({ appSettings, logger, providerSettings, runtimes, scope }) => {
      const sync = new SubagentRoutingSync({
        router: createSubagentRouter(),
        settings: () => appSettings.get('subagentRouting'),
        usage: usageLimitsServiceFor({ runtimes, providerSettings }),
        snapshotFile: resolveSubagentRoutingFile(),
        logger,
      });
      const onChanged = (key: string) => {
        if (key === 'subagentRouting') void sync.refresh().catch(() => undefined);
      };
      appSettings.on('app-settings:changed', onChanged);
      scope.add(() => {
        appSettings.off('app-settings:changed', onChanged);
        sync.dispose();
      });
      void sync.start().catch(() => undefined);
      return createSubagentRoutingWireController(sync);
    },
  },
  host: {
    create: ({ hostOperations }) => createDesktopHostWireController(hostOperations),
  },
  voice: {
    create: ({ voiceOperations }) => createVoiceWireController(voiceOperations),
  },
  remoteAccess: {
    create: ({ remoteAccess }) => createRemoteAccessWireController(remoteAccess),
  },
  outsideAgents: {
    create: ({ outsideAgents }) => createOutsideAgentsWireController(outsideAgents),
  },
} satisfies {
  readonly [Domain in DesktopDomain]: DesktopNodeControllerContribution;
};
