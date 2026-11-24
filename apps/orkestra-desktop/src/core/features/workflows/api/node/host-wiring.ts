// Kod iş akışlarını masaüstü ana sürecinin mevcut servislerine bağlayan küçük yardımcılar:
// görev/sohbet aramaları, issue ve PR yoklama kaynakları, soru bildirimi. Yeni kimlik doğrulama
// eklenmez; yalnızca projeye zaten bağlı sağlayıcı istemcileri kullanılır.
import { and, eq, isNull } from 'drizzle-orm';
import { createConversationRegistry } from '@core/features/conversations/api/node/registry/conversation-registry';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import type {
  IssueListResult,
  IssueProviderType,
  IssueQueryOpts,
} from '@core/primitives/issue-providers/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { tasks } from '@core/services/app-db/node/schema';
import type { NotificationService } from '@core/services/notifications/node';
import type { PullRequestsRuntimeClient } from '@core/services/pull-requests/api';
import type { CodeWorkflowEntry, CodeWorkflowRun } from '../contract';
import type { PollSources } from './engine';
import {
  defaultWorkflowsFolder,
  type CodeWorkflowsHostOptions,
  type WorkflowHookServer,
} from './service';

type TaskContext = { projectId: string; taskId: string };

export function createTaskLookups(db: AppDb) {
  return {
    async resolveTask(taskId: string): Promise<TaskContext | null> {
      const [row] = await db
        .select({ projectId: tasks.projectId, taskId: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
        .limit(1);
      return row ?? null;
    },
    async resolveConversation(conversationId: string): Promise<TaskContext | null> {
      const row = createConversationRegistry(db).getLive(conversationId);
      return row?.projectId && row.taskId ? { projectId: row.projectId, taskId: row.taskId } : null;
    },
  };
}

/** Projenin temel uzak deposunun URL'si (issue işlemlerinin kullandığı çözümle aynı). */
async function projectRepositoryUrl(
  projects: Pick<ProjectAttachmentManager, 'requireAttached'>,
  projectId: string
): Promise<string | null> {
  const attached = projects.requireAttached(projectId);
  if (!attached.success) return null;
  const project = attached.data;
  const remote = await project.gitRepository.getBaseRemote().catch(() => undefined);
  if (!remote) return null;
  const remotes = await project.git.repository.model
    .state(project.repository, 'remotes')
    .snapshot()
    .then((snapshot) => snapshot.data.remotes)
    .catch(() => []);
  return remotes.find((candidate) => candidate.name === remote)?.url ?? null;
}

/** Issue işlemlerinin mevcut listeleme işlevi (projenin bağlı hesabıyla). */
export type ListIssues = (
  provider: IssueProviderType,
  options: IssueQueryOpts
) => Promise<IssueListResult>;

export function createPollSources(deps: {
  listIssues: ListIssues;
  projects: Pick<ProjectAttachmentManager, 'requireAttached'>;
  getPullRequestsClient(): Promise<PullRequestsRuntimeClient>;
}): PollSources {
  return {
    async issues(trigger) {
      const provider = (trigger.provider ?? 'github') as IssueProviderType;
      const result = await deps.listIssues(provider, { projectId: trigger.project, limit: 50 });
      if (!result.success) {
        throw new Error(result.error.message);
      }
      return result.data.map((issue) => ({
        provider: issue.provider,
        identifier: issue.identifier,
        displayIdentifier: issue.displayIdentifier ?? null,
        title: issue.title,
        url: issue.url,
        project: trigger.project,
      }));
    },
    async pullRequests(trigger) {
      const repositoryUrl = await projectRepositoryUrl(deps.projects, trigger.project);
      if (!repositoryUrl) throw new Error(`Project ${trigger.project} has no remote repository.`);
      const client = await deps.getPullRequestsClient();
      const result = await client.listPullRequests({
        repositoryUrls: [repositoryUrl],
        cursor: null,
        limit: 50,
        sort: 'newest',
        filters: { status: 'open' },
      });
      if (!result.success) throw new Error(JSON.stringify(result.error));
      return result.data.prs.map((pr) => {
        const digits = /(\d+)$/.exec(pr.identifier ?? pr.url)?.[1];
        return {
          identifier: pr.identifier ?? pr.url,
          number: digits ? Number(digits) : null,
          title: pr.title,
          url: pr.url,
          author: pr.author?.userName ?? null,
          project: trigger.project,
        };
      });
    },
  };
}

/** `ask` açılınca uygulama içi (ve ayara göre işletim sistemi) bildirimi. */
export function publishWorkflowQuestion(
  notifications: Pick<NotificationService, 'publish'>,
  run: CodeWorkflowRun,
  entry: CodeWorkflowEntry
): void {
  notifications.publish({
    kind: 'workflow-question',
    groupKey: `workflow-question:${run.id}`,
    dedupeKey: `workflow-question:${run.id}:${entry.name}`,
    title: `Workflow needs you: ${run.title ?? run.workflow}`,
    body: `${entry.question?.title ?? entry.name} — answer it on the Workflows page.`,
    sound: 'needs_attention',
    target: { kind: 'none' },
    source: { kind: 'app' },
  });
}

/** Masaüstü ana sürecindeki servislerden kod iş akışı bağlantılarını kurar. */
export function createDesktopCodeWorkflowsHost(deps: {
  appSettings: {
    get(key: 'codeWorkflows'): Promise<{ enabled: boolean }>;
    on(event: 'app-settings:changed', listener: (key: string) => void): void;
    off(event: 'app-settings:changed', listener: (key: string) => void): void;
  };
  hooks: WorkflowHookServer;
  notifications: Pick<NotificationService, 'publish'>;
  listIssues: ListIssues;
  projects: Pick<ProjectAttachmentManager, 'requireAttached'>;
  getPullRequestsClient(): Promise<PullRequestsRuntimeClient>;
  openPath(path: string): Promise<string>;
}): CodeWorkflowsHostOptions {
  return {
    folder: defaultWorkflowsFolder(),
    isEnabled: async () => (await deps.appSettings.get('codeWorkflows')).enabled,
    onSettingsChanged: (listener) => {
      const handler = (key: string) => {
        if (key === 'codeWorkflows') listener();
      };
      deps.appSettings.on('app-settings:changed', handler);
      return () => deps.appSettings.off('app-settings:changed', handler);
    },
    pollSources: createPollSources({
      listIssues: deps.listIssues,
      projects: deps.projects,
      getPullRequestsClient: deps.getPullRequestsClient,
    }),
    hooks: deps.hooks,
    onQuestion: (run, entry) => publishWorkflowQuestion(deps.notifications, run, entry),
    openPath: deps.openPath,
  };
}
