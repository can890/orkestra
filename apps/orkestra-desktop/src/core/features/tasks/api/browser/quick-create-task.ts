import type { GitBranchRef } from '@orkestra/core/runtimes/git/api';
import { toast } from '@orkestra/ui/react/primitives';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { getConversationsForTask } from '@core/features/conversations/api/browser/conversation-selectors';
import { nextDefaultConversationTitle } from '@core/features/conversations/api/browser/conversation-title-utils';
import {
  recordLastUsedAgent,
  resolveLastUsedAgentForHost,
} from '@core/features/conversations/api/browser/last-used-agent';
import { resolveDefaultPermissionForProvider } from '@core/features/conversations/api/default-permission-mode';
import {
  asAvailableProject,
  getProjectSshConnectionId,
  getProjectStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { fetchAppSettingsMeta } from '@core/features/settings/api/browser/app-settings-client';
import {
  inspectProjectPath,
  readCheckoutHead,
} from '@core/features/source-control/api/browser/client';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { getTasksWireClient } from '@core/features/tasks/api/browser/client';
import {
  getTaskManagerStore,
  taskHostActionAvailability,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import type { BranchNamingMode, DefaultPermissionMode } from '@core/primitives/app-settings/api';
import { log } from '@core/primitives/logging/browser/logger';
import type { NavigateFnTyped } from '@core/primitives/navigation/browser/navigation-hooks';
import { resolveTaskBranchName, type TaskConfig } from '@core/primitives/tasks/api';
import {
  buildWorkspaceConfigFromPreset,
  type WorkspaceConfig,
} from '@core/primitives/workspaces/api';

const PLACEHOLDER_TASK_TITLE = 'Yeni sohbet';
const AUTO_APPROVE_STORAGE_KEY = 'initial-conversation:auto-approve-enabled';

const inFlightProjects = new Set<string>();

export type QuickTaskCandidate = {
  id: string;
  name: string;
  archivedAt?: string;
  updatedAt?: string;
  lastInteractedAt?: string;
  conversations?: ReadonlyArray<{
    sessionId?: string | null;
    initialQueue?: ReadonlyArray<unknown> | null;
  }>;
};

export function isPlaceholderQuickTaskName(name: string): boolean {
  const normalized = name.trim().toLocaleLowerCase('tr-TR');
  return (
    /^yeni\s+sohbet(?:\s*\(\d+\))?$/i.test(normalized) ||
    /^new\s+chat(?:\s*\(\d+\))?$/i.test(normalized)
  );
}

export function findReusableEmptyQuickTask<T extends QuickTaskCandidate>(
  candidates: Iterable<T>
): T | null {
  const matches: T[] = [];
  for (const task of candidates) {
    if (task.archivedAt) continue;
    if (!isPlaceholderQuickTaskName(task.name)) continue;
    if (!task.conversations) continue;
    const isUntouched = task.conversations.every(
      (c) => !c.sessionId && (!c.initialQueue || c.initialQueue.length === 0)
    );
    if (isUntouched) {
      matches.push(task);
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) =>
    (b.lastInteractedAt ?? b.updatedAt ?? '').localeCompare(a.lastInteractedAt ?? a.updatedAt ?? '')
  );
  return matches[0] ?? null;
}

export function pickPlaceholderTaskName(existingTaskNames: Iterable<string>): string {
  const taken = new Set(
    Array.from(existingTaskNames, (name) => name.trim().toLocaleLowerCase('tr-TR')).filter(Boolean)
  );
  if (!taken.has(PLACEHOLDER_TASK_TITLE.toLocaleLowerCase('tr-TR'))) {
    return PLACEHOLDER_TASK_TITLE;
  }
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${PLACEHOLDER_TASK_TITLE} (${i})`;
    if (!taken.has(candidate.toLocaleLowerCase('tr-TR'))) {
      return candidate;
    }
  }
  return PLACEHOLDER_TASK_TITLE;
}

export type BuildQuickTaskWorkspaceConfigInput = {
  hasRepository: boolean;
  isUnborn: boolean;
  defaultBranch: GitBranchRef | undefined;
  repositoryWorkspaceId: string | null | undefined;
  createBranchAndWorktree: boolean;
  pushOnCreate: boolean;
  canPublish: boolean;
  branchSlug: string;
  branchPrefix?: string;
  branchNamingMode?: BranchNamingMode;
  branchNamingInstructions?: string;
  appendRandomSuffix?: boolean;
  suffix?: string;
  existingLocalBranches?: Iterable<string>;
};

function hasBranchCollision(candidate: string, existingLocalBranches: Set<string>): boolean {
  return (
    existingLocalBranches.has(candidate) || existingLocalBranches.has(`refs/heads/${candidate}`)
  );
}

export function buildQuickTaskWorkspaceConfig(
  input: BuildQuickTaskWorkspaceConfigInput
): WorkspaceConfig {
  const repoWsId = input.repositoryWorkspaceId ?? undefined;
  if (
    !input.hasRepository ||
    input.isUnborn ||
    !input.defaultBranch ||
    !input.createBranchAndWorktree
  ) {
    return buildWorkspaceConfigFromPreset('repo-root', {
      repositoryWorkspaceId: repoWsId,
    });
  }

  const baseBranch = resolveTaskBranchName({
    rawBranch: input.branchSlug,
    branchPrefix: input.branchPrefix ?? '',
    branchNamingMode: input.branchNamingMode ?? 'static',
    branchNamingInstructions: input.branchNamingInstructions,
    suffix: input.suffix ?? Math.random().toString(36).slice(2, 7),
    appendRandomSuffix: input.appendRandomSuffix ?? true,
  });

  const existing = new Set(input.existingLocalBranches ?? []);
  let branchName = baseBranch || `chat-${Math.random().toString(36).slice(2, 8)}`;
  if (hasBranchCollision(branchName, existing)) {
    for (let i = 2; i < 100; i += 1) {
      const candidate = `${branchName}-${i}`;
      if (!hasBranchCollision(candidate, existing)) {
        branchName = candidate;
        break;
      }
    }
  }

  return buildWorkspaceConfigFromPreset(
    'new-worktree',
    {
      defaultBranch: input.defaultBranch,
      repositoryWorkspaceId: repoWsId,
    },
    {
      branchName,
      fromBranch: input.defaultBranch,
      pushBranch: input.canPublish && input.pushOnCreate,
      createBranch: true,
    }
  );
}

function readAutoApproveStoragePreference(fallback: boolean): boolean {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(AUTO_APPROVE_STORAGE_KEY);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    return typeof parsed === 'boolean' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function readCheckoutHeadWithTimeout(workspaceId: string, timeoutMs = 1500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readCheckoutHead(workspaceId).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function quickCreateTask(params: {
  projectId: string;
  navigate: NavigateFnTyped;
}): Promise<{ taskId: string } | null> {
  const { projectId, navigate } = params;
  if (inFlightProjects.has(projectId)) return null;
  if (taskHostActionAvailability(projectId).kind !== 'enabled') return null;

  const taskManager = getTaskManagerStore(projectId);
  const projectContext = asAvailableProject(getProjectStore(projectId));
  if (!taskManager || !projectContext) return null;

  inFlightProjects.add(projectId);
  try {
    // Henüz mesaj gönderilmemiş boş bir "Yeni sohbet" varsa gereksiz worktree açma, ona geç.
    const placeholderStores = Array.from(taskManager.tasks.values()).filter((task) => {
      const data = task.data;
      return !('archivedAt' in data && data.archivedAt) && isPlaceholderQuickTaskName(data.name);
    });
    if (placeholderStores.length > 0) {
      let conversationsClient: Awaited<ReturnType<typeof getConversationsClient>> | null = null;
      const candidates: QuickTaskCandidate[] = [];
      for (const store of placeholderStores) {
        const data = store.data;
        const regManager = getConversationsForTask(data.id);
        let convs: QuickTaskCandidate['conversations'];
        if (regManager && regManager.list.data !== undefined && !regManager.list.loading) {
          convs = Array.from(regManager.conversations.values(), (c) => ({
            sessionId: c.data.sessionId,
            initialQueue: c.data.initialQueue,
          }));
        } else {
          try {
            conversationsClient ??= await getConversationsClient();
            const list = await conversationsClient.getConversationsForTask({
              projectId,
              taskId: data.id,
            });
            convs = list.map((c) => ({
              sessionId: c.sessionId,
              initialQueue: c.initialQueue,
            }));
          } catch {
            convs = undefined;
          }
        }
        candidates.push({
          id: data.id,
          name: data.name,
          archivedAt: 'archivedAt' in data ? data.archivedAt : undefined,
          updatedAt: 'updatedAt' in data ? data.updatedAt : undefined,
          lastInteractedAt: 'lastInteractedAt' in data ? data.lastInteractedAt : undefined,
          conversations: convs,
        });
      }
      const reusable = findReusableEmptyQuickTask(candidates);
      if (reusable) {
        navigate(taskViewDef({ projectId, taskId: reusable.id }));
        return { taskId: reusable.id };
      }
    }

    const project = projectContext.project;
    const repositoryWorkspaceId = project.repositoryWorkspaceId ?? null;
    const connectionId = getProjectSshConnectionId(projectId);
    const repo = getGitRepositoryStore(projectId);

    const [tasksMeta, projectMeta, defaultAgentMeta] = await Promise.all([
      fetchAppSettingsMeta('tasks').catch(() => null),
      fetchAppSettingsMeta('project').catch(() => null),
      fetchAppSettingsMeta('defaultAgent').catch(() => null),
    ]);

    const tasksSettings = tasksMeta?.value;
    const projectSettings = projectMeta?.value;
    const defaultAgent = defaultAgentMeta?.value ?? null;

    const createBranchAndWorktree = tasksSettings?.createBranchAndWorktree ?? true;
    const autoApproveByDefault = tasksSettings?.autoApproveByDefault ?? false;
    const hasPermissionModeOverride = Boolean(
      tasksMeta && 'defaultPermissionMode' in tasksMeta.overrides
    );
    const defaultPermissionMode: DefaultPermissionMode =
      !hasPermissionModeOverride && autoApproveByDefault
        ? 'bypass'
        : (tasksSettings?.defaultPermissionMode ?? 'default');

    const [pathInspection, head, , agentSelection, generatedSlug] = await Promise.all([
      inspectProjectPath(
        project.type === 'ssh'
          ? { type: 'ssh', connectionId: project.connectionId, path: project.path }
          : { type: 'local', path: project.path }
      ).catch(() => null),
      repositoryWorkspaceId
        ? readCheckoutHeadWithTimeout(repositoryWorkspaceId)
        : Promise.resolve(undefined),
      repo && !repo.defaultBranchRef
        ? repo.localData.load().catch(() => undefined)
        : Promise.resolve(),
      resolveLastUsedAgentForHost({ connectionId, defaultAgent }),
      createBranchAndWorktree
        ? getTasksWireClient()
            .then((client) => client.generateTaskName({}))
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    const hasRepository = pathInspection?.error ? true : (pathInspection?.isGitRepo ?? true);
    const isUnborn = head?.kind === 'unborn';
    const taskName = pickPlaceholderTaskName(
      Array.from(taskManager.tasks.values(), (task) => task.data.name)
    );

    const workspaceConfig = buildQuickTaskWorkspaceConfig({
      hasRepository,
      isUnborn,
      defaultBranch: repo?.defaultBranchRef,
      repositoryWorkspaceId,
      createBranchAndWorktree,
      pushOnCreate: projectSettings?.pushOnCreate ?? true,
      canPublish: Boolean(repo?.pushRemote),
      branchSlug: generatedSlug?.trim() || `chat-${crypto.randomUUID().slice(0, 8)}`,
      branchPrefix: projectSettings?.branchPrefix ?? '',
      branchNamingMode: projectSettings?.branchNamingMode ?? 'static',
      branchNamingInstructions: projectSettings?.branchNamingInstructions ?? '',
      appendRandomSuffix: projectSettings?.appendRandomBranchSuffix ?? true,
      existingLocalBranches: repo?.localBranches.map((branch) => branch.ref) ?? [],
    });

    let initialConversation: NonNullable<TaskConfig['initialConversation']> | undefined;
    if (agentSelection.providerId) {
      const conversationType = agentSelection.supportsAcp ? 'acp' : 'pty';
      const autoApprovePreference = readAutoApproveStoragePreference(autoApproveByDefault);
      const effectiveAutoApprove = agentSelection.supportsAutoApprove && autoApprovePreference;
      const effectivePermissionMode: DefaultPermissionMode = effectiveAutoApprove
        ? 'bypass'
        : defaultPermissionMode;
      const resolvedPermission =
        conversationType === 'acp'
          ? resolveDefaultPermissionForProvider(agentSelection.providerId, effectivePermissionMode)
          : null;
      const autoApprove =
        agentSelection.supportsAutoApprove &&
        (effectiveAutoApprove || Boolean(resolvedPermission?.autoApprove));

      initialConversation = {
        id: crypto.randomUUID(),
        provider: agentSelection.providerId,
        title: nextDefaultConversationTitle(agentSelection.providerId, []),
        autoApprove,
        ...(resolvedPermission?.modeId ? { modeId: resolvedPermission.modeId } : {}),
        ...(agentSelection.model ? { model: agentSelection.model } : {}),
        ...(conversationType === 'acp' && agentSelection.effort
          ? { effort: agentSelection.effort }
          : {}),
        type: conversationType,
      };
    }

    const taskId = crypto.randomUUID();
    const createdPromise = taskManager.createTask({
      id: taskId,
      projectId,
      taskConfig: {
        version: '1',
        name: taskName,
        initialConversation,
      },
      workspaceConfig,
    });

    navigate(taskViewDef({ projectId, taskId }));

    if (initialConversation) {
      recordLastUsedAgent({
        providerId: initialConversation.provider,
        model: initialConversation.model,
        effort: initialConversation.effort,
      });
    }

    void createdPromise.catch((error: unknown) => {
      log.error('quick create task failed', error);
      toast.error('Yeni sohbet oluşturulamadı', {
        description: error instanceof Error ? error.message : String(error),
      });
    });

    return { taskId };
  } catch (error) {
    log.error('quick create task preflight failed', error);
    toast.error('Yeni sohbet oluşturulamadı', {
      description: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    inFlightProjects.delete(projectId);
  }
}
