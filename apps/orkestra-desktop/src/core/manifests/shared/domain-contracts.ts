import { accountContract, accountDomain } from '@core/features/account/api';
import { acpRegistryContract, acpRegistryDomain } from '@core/features/acp-registry/api';
import { agentsContract, agentsDomain } from '@core/features/agents/api';
import { appearanceContract, appearanceDomain } from '@core/features/appearance/api';
import { artifactSharesContract, artifactSharesDomain } from '@core/features/artifact-shares/api';
import { automationsContract, automationsDomain } from '@core/features/automations/api';
import { browserContract, browserDomain } from '@core/features/browser/api';
import { catalogDomain, catalogWireContract } from '@core/features/catalog/api';
import { chromeContract, chromeDomain } from '@core/features/chrome/api/contract';
import { computerUseContract, computerUseDomain } from '@core/features/computer-use/api';
import { conversationsContract, conversationsDomain } from '@core/features/conversations/api';
import { devPerfContract, devPerfDomain } from '@core/features/dev-perf/api';
import { editorContract, editorDomain } from '@core/features/editor/api';
import { filesDomain, filesWireContract } from '@core/features/files/api';
import { githubContract, githubDomain } from '@core/features/github/api';
import { integrationsContract, integrationsDomain } from '@core/features/integrations/api';
import { issuesContract, issuesDomain } from '@core/features/issues/api';
import { legacyPortContract, legacyPortDomain } from '@core/features/legacy-port/api';
import { promptLibraryContract, promptLibraryDomain } from '@core/features/library/api';
import {
  lifecycleHooksContract,
  lifecycleHooksDomain,
} from '@core/features/lifecycle-hooks/api/contract';
import { logHealthContract, logHealthDomain } from '@core/features/log-health/api/contract';
import { machinesContract, machinesDomain } from '@core/features/machines/api';
import { mcpAppsContract, mcpAppsDomain } from '@core/features/mcp-apps/api';
import {
  managedPolicyContract,
  managedPolicyDomain,
} from '@core/features/managed-policy/api/contract';
import { mcpContract, mcpDomain } from '@core/features/mcp/api';
import {
  outsideAgentsContract,
  outsideAgentsDomain,
} from '@core/features/outside-agents/api/contract';
import { pluginPacksContract, pluginPacksDomain } from '@core/features/plugin-packs/api';
import { previewServersContract, previewServersDomain } from '@core/features/preview-servers/api';
import { projectMemoryContract, projectMemoryDomain } from '@core/features/project-memory/api';
import {
  projectRepositoriesContract,
  projectRepositoriesDomain,
} from '@core/features/project-repositories/api/contract';
import { projectsDomain, projectsWireContract } from '@core/features/projects/api';
import {
  remoteAccessContract,
  remoteAccessDomain,
} from '@core/features/remote-access/api/contract';
import { repositoryContract, repositoryDomain } from '@core/features/repository/api';
import { searchContract, searchDomain } from '@core/features/search/api';
import { secretsContract, secretsDomain } from '@core/features/secrets/api/contract';
import { simulatorContract, simulatorDomain } from '@core/features/simulator/api';
import { skillsContract, skillsDomain } from '@core/features/skills/api';
import { snapshotContract, snapshotDomain } from '@core/features/snapshot/api/contract';
import { sourceControlContract, sourceControlDomain } from '@core/features/source-control/api';
import { tasksDomain, tasksWireContract } from '@core/features/tasks/api';
import { terminalsContract, terminalsDomain } from '@core/features/terminals/api';
import {
  textGenerationContract,
  textGenerationDomain,
} from '@core/features/text-generation/api/contract';
import { updatesContract, updatesDomain } from '@core/features/updates/api';
import {
  usageLimitsContract,
  usageLimitsDomain,
} from '@core/features/usage-limits/api/usage-limits';
import { voiceContract, voiceDomain } from '@core/features/voice/api/contract';
import {
  lifecycleScriptsDomain,
  lifecycleScriptsWireContract,
  projectSettingsContract,
  projectSettingsDomain,
  projectWorkspacesContract,
  projectWorkspacesDomain,
  workspaceRegistryDomain,
  workspaceRegistryWireContract,
  workspacesDomain,
  workspacesWireContract,
} from '@core/features/workspaces/api';
import {
  desktopHostContract,
  desktopHostDomain,
} from '@core/primitives/desktop-host/api/host-contract';
import { loggingDomain, loggingWireContract } from '@core/primitives/logging/api/wire-contract';
import { mementosDomain, mementosWireContract } from '@core/primitives/mementos/api';
import { telemetryContract, telemetryDomain } from '@core/primitives/telemetry/api/wire-contract';
import { hostsContract, hostsDomain } from '@core/services/hosts/api';
import {
  hostMaintenanceContract,
  hostMaintenanceDomain,
} from '@core/services/hosts/api/maintenance-contract';
import { notificationsContract, notificationsDomain } from '@core/services/notifications/api';
import { pullRequestsContract, pullRequestsDomain } from '@core/services/pull-requests/api';
import { appSettingsContract, appSettingsDomain } from '@core/services/settings/api';
import { sshContract, sshDomain } from '@core/services/ssh/api';

export const desktopDomainContracts = {
  [accountDomain]: accountContract,
  [acpRegistryDomain]: acpRegistryContract,
  [agentsDomain]: agentsContract,
  [appearanceDomain]: appearanceContract,
  [appSettingsDomain]: appSettingsContract,
  [devPerfDomain]: devPerfContract,
  [editorDomain]: editorContract,
  [filesDomain]: filesWireContract,
  [legacyPortDomain]: legacyPortContract,
  [loggingDomain]: loggingWireContract,
  [lifecycleHooksDomain]: lifecycleHooksContract,
  [logHealthDomain]: logHealthContract,
  [machinesDomain]: machinesContract,
  [projectMemoryDomain]: projectMemoryContract,
  [projectRepositoriesDomain]: projectRepositoriesContract,
  [projectSettingsDomain]: projectSettingsContract,
  [projectWorkspacesDomain]: projectWorkspacesContract,
  [promptLibraryDomain]: promptLibraryContract,
  [repositoryDomain]: repositoryContract,
  [searchDomain]: searchContract,
  [secretsDomain]: secretsContract,
  [telemetryDomain]: telemetryContract,
  [sourceControlDomain]: sourceControlContract,
  [mcpDomain]: mcpContract,
  [mcpAppsDomain]: mcpAppsContract,
  [skillsDomain]: skillsContract,
  [simulatorDomain]: simulatorContract,
  [snapshotDomain]: snapshotContract,
  [pluginPacksDomain]: pluginPacksContract,
  [terminalsDomain]: terminalsContract,
  [mementosDomain]: mementosWireContract,
  [notificationsDomain]: notificationsContract,
  [pullRequestsDomain]: pullRequestsContract,
  [catalogDomain]: catalogWireContract,
  [workspacesDomain]: workspacesWireContract,
  [workspaceRegistryDomain]: workspaceRegistryWireContract,
  [lifecycleScriptsDomain]: lifecycleScriptsWireContract,
  [projectsDomain]: projectsWireContract,
  [automationsDomain]: automationsContract,
  [browserDomain]: browserContract,
  [chromeDomain]: chromeContract,
  [conversationsDomain]: conversationsContract,
  [computerUseDomain]: computerUseContract,
  [previewServersDomain]: previewServersContract,
  [artifactSharesDomain]: artifactSharesContract,
  [githubDomain]: githubContract,
  [integrationsDomain]: integrationsContract,
  [issuesDomain]: issuesContract,
  [sshDomain]: sshContract,
  [hostsDomain]: hostsContract,
  [hostMaintenanceDomain]: hostMaintenanceContract,
  [tasksDomain]: tasksWireContract,
  [textGenerationDomain]: textGenerationContract,
  [updatesDomain]: updatesContract,
  [usageLimitsDomain]: usageLimitsContract,
  [voiceDomain]: voiceContract,
  [remoteAccessDomain]: remoteAccessContract,
  [outsideAgentsDomain]: outsideAgentsContract,
  [managedPolicyDomain]: managedPolicyContract,
  [desktopHostDomain]: desktopHostContract,
} as const;
