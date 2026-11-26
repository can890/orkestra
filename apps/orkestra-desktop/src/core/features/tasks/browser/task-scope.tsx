import { toast } from '@orkestra/ui/react/primitives';
import { useLayoutEffect, type ReactNode } from 'react';
import { browserControlsRegistry } from '@core/features/browser/api/browser/browser-controls-registry';
import { browserMiniPlayerStore } from '@core/features/browser/api/browser/browser-mini-player-store';
import { browserRightPanelStore } from '@core/features/browser/api/browser/browser-right-panel-store';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { createQuickConversation } from '@core/features/conversations/api/browser/quick-conversation';
import {
  runGitFetch,
  runGitPublishCurrentBranch,
  runGitPull,
  runGitPush,
} from '@core/features/source-control/api/browser/git-action-handlers';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { getTaskGitCheckoutStore } from '@core/features/source-control/api/browser/stores/task-source-control-selectors';
import {
  asProvisioned,
  getRegisteredTaskData,
  getTaskManagerStore,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewScope } from '@core/features/tasks/contributions/scopes';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import { openModal } from '@core/manifests/browser/modal-api';
import { normalizeBrowserUrl } from '@core/primitives/browser/api';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import {
  disabled,
  enabled,
  hidden,
  type CommandAvailability,
  type ViewScopeImpl,
} from '@core/primitives/view-scopes/api';
import { scopes } from '@core/primitives/view-scopes/browser';
import { useViewScope, ViewScopeInstanceProvider } from '@core/primitives/view-scopes/react';

type TaskScopeParams = { readonly projectId: string; readonly taskId: string };

function taskAvailability(
  params: TaskScopeParams,
  predicate: () => boolean = () => true,
  reason = 'Command is unavailable'
): CommandAvailability {
  if (getTaskStore(params.projectId, params.taskId)?.state !== 'provisioned') return hidden;
  return predicate() ? enabled : disabled(reason);
}

function activeBrowser(params: TaskScopeParams) {
  const browserId =
    browserRightPanelStore.visibleBrowserForTask(params.projectId, params.taskId) ??
    browserMiniPlayerStore.floatingBrowserForTask(params.projectId, params.taskId);
  const session = browserId ? browserSessionStore.getSession(browserId) : undefined;
  return {
    browserId,
    session: session ?? null,
  };
}

async function createConversationSplitRight(params: TaskScopeParams): Promise<void> {
  const outcome = await openModal('createConversationModal', params);
  if (!outcome.success) return;
  const taskView = getTaskComposition(params.projectId, params.taskId);
  const { conversationId, type } = outcome.data;
  taskView?.paneLayout.open(
    type === 'acp' ? 'acp-chat' : 'conversation',
    { conversationId },
    { preview: false, target: 'right' }
  );
  taskView?.setFocusedRegion('main');
}

const taskScopeImplementation = {
  'task.newConversation': (params) => ({
    availability: () => taskAvailability(params),
    execute: () => {
      void createQuickConversation(params).then((conversation) => {
        if (!conversation) return;
        const taskView = getTaskComposition(params.projectId, params.taskId);
        taskView?.paneLayout.open(
          conversation.type === 'acp' ? 'acp-chat' : 'conversation',
          { conversationId: conversation.id },
          { preview: false }
        );
        taskView?.setFocusedRegion('main');
      });
    },
  }),
  'task.newConversationSplitRight': (params) => ({
    availability: () => taskAvailability(params),
    execute: () => {
      void createConversationSplitRight(params);
    },
  }),
  'task.sidebarChanges': (params) => ({
    availability: () => taskAvailability(params),
    execute: () => {
      getTaskComposition(params.projectId, params.taskId)?.chrome.commands.toggleSidebarTab(
        'changes'
      );
    },
  }),
  'task.sidebarConversations': (params) => ({
    availability: () => taskAvailability(params),
    execute: () => {
      getTaskComposition(params.projectId, params.taskId)?.chrome.commands.toggleSidebarTab(
        'conversations'
      );
    },
  }),
  'task.sidebarFiles': (params) => ({
    availability: () => taskAvailability(params),
    execute: () => {
      getTaskComposition(params.projectId, params.taskId)?.chrome.commands.toggleSidebarTab(
        'files'
      );
    },
  }),
  'task.fileContentSearch': (params) => ({
    availability: () => taskAvailability(params),
    execute: () => {
      const taskView = getTaskComposition(params.projectId, params.taskId);
      if (!taskView) return;
      taskView.chrome.commands.openSidebarTab('files');
      taskView.editorView.requestFileSearchFocus();
    },
  }),
  'task.viewTerminals': (params) => ({
    availability: () => taskAvailability(params),
    execute: () => {
      getTaskComposition(params.projectId, params.taskId)?.chrome.commands.openTerminalDrawer();
    },
  }),
  'task.toggleTerminalDrawer': (params) => ({
    availability: () => taskAvailability(params),
    execute: () => {
      const taskView = getTaskComposition(params.projectId, params.taskId);
      if (!taskView) return;
      if (taskView.isTerminalDrawerOpen) {
        taskView.chrome.commands.closeTerminalDrawer();
      } else if (taskView.terminalTabs.tabs.length === 0) {
        void taskView.openNewTerminal();
      } else {
        taskView.chrome.commands.openTerminalDrawer();
      }
    },
  }),
  'task.toggleRightSidebar': (params) => ({
    availability: () => taskAvailability(params),
    presentation: () => {
      const collapsed = getTaskComposition(params.projectId, params.taskId)?.isSidebarCollapsed;
      return {
        title: collapsed ? 'Show Right Sidebar' : 'Hide Right Sidebar',
      };
    },
    execute: () => {
      getTaskComposition(params.projectId, params.taskId)?.chrome.commands.toggleSidebar();
    },
  }),
  'task.newTerminal': (params) => ({
    availability: () => taskAvailability(params),
    execute: () => {
      void getTaskComposition(params.projectId, params.taskId)?.openNewTerminal();
    },
  }),
  'task.openBrowser': (params) => ({
    availability: () => taskAvailability(params),
    execute: () => {
      const workspaceId =
        asProvisioned(getTaskStore(params.projectId, params.taskId))?.workspaceId ?? params.taskId;
      browserRightPanelStore.openPanel({
        projectId: params.projectId,
        workspaceId,
        taskId: params.taskId,
      });
    },
  }),
  'task.browserGoBack': (params) => ({
    availability: () =>
      taskAvailability(
        params,
        () => Boolean(activeBrowser(params).session?.canGoBack),
        'Browser cannot go back'
      ),
    execute: () => {
      const { browserId } = activeBrowser(params);
      if (!browserId) return;
      const adapter = browserControlsRegistry.get(browserId)?.adapter;
      if (adapter?.canGoBack()) adapter.goBack();
    },
  }),
  'task.browserGoForward': (params) => ({
    availability: () =>
      taskAvailability(
        params,
        () => Boolean(activeBrowser(params).session?.canGoForward),
        'Browser cannot go forward'
      ),
    execute: () => {
      const { browserId } = activeBrowser(params);
      if (!browserId) return;
      const adapter = browserControlsRegistry.get(browserId)?.adapter;
      if (adapter?.canGoForward()) adapter.goForward();
    },
  }),
  'task.browserReload': (params) => ({
    availability: () =>
      taskAvailability(params, () => Boolean(activeBrowser(params).browserId), 'No active browser'),
    execute: () => {
      const { browserId } = activeBrowser(params);
      if (browserId) browserControlsRegistry.get(browserId)?.adapter?.reload();
    },
  }),
  'task.browserFocusUrl': (params) => ({
    availability: () =>
      taskAvailability(params, () => Boolean(activeBrowser(params).browserId), 'No active browser'),
    execute: () => {
      const { browserId } = activeBrowser(params);
      if (browserId) browserControlsRegistry.get(browserId)?.focusUrl();
    },
  }),
  'task.browserOpenExternal': (params) => ({
    availability: () =>
      taskAvailability(params, () => Boolean(activeBrowser(params).session), 'No active browser'),
    execute: () => {
      const { session } = activeBrowser(params);
      if (!session) return;
      const normalized = normalizeBrowserUrl(session.currentUrl);
      if (normalized.ok && (normalized.protocol === 'http:' || normalized.protocol === 'https:')) {
        void openExternal(normalized.url);
      }
    },
  }),
  'task.browserCopyUrl': (params) => ({
    availability: () => {
      if (getTaskStore(params.projectId, params.taskId)?.state !== 'provisioned') return hidden;
      return activeBrowser(params).session ? enabled : hidden;
    },
    execute: () => {
      const { session } = activeBrowser(params);
      if (!session) return;
      const normalized = normalizeBrowserUrl(session.currentUrl, { allowSearchQueries: false });
      if (!normalized.ok) return;
      void navigator.clipboard
        .writeText(normalized.url)
        .then(() => toast('Browser URL copied'))
        .catch(() => toast.error('Could not copy browser URL'));
    },
  }),
  'task.gitFetch': (params) => ({
    availability: () =>
      taskAvailability(
        params,
        () => Boolean(getGitRepositoryStore(params.projectId)),
        'No Git repository'
      ),
    execute: () => {
      const repository = getGitRepositoryStore(params.projectId);
      if (repository) void runGitFetch(repository);
    },
  }),
  'task.gitPull': (params) => ({
    availability: () =>
      taskAvailability(
        params,
        () => Boolean(getTaskGitCheckoutStore(params.projectId, params.taskId)),
        'No Git checkout'
      ),
    execute: () => {
      const git = getTaskGitCheckoutStore(params.projectId, params.taskId);
      if (git) void runGitPull(git);
    },
  }),
  'task.gitPush': (params) => ({
    availability: () =>
      taskAvailability(
        params,
        () => getTaskGitCheckoutStore(params.projectId, params.taskId)?.headKind === 'branch',
        'No branch is checked out'
      ),
    presentation: () => {
      const git = getTaskGitCheckoutStore(params.projectId, params.taskId);
      return git?.isPublished
        ? { title: 'Git Push', description: 'Push commits to remote' }
        : { title: 'Git Publish Branch', description: 'Publish this branch to remote' };
    },
    execute: () => {
      const git = getTaskGitCheckoutStore(params.projectId, params.taskId);
      if (!git) return;
      if (git.isPublished) {
        void runGitPush(git);
        return;
      }
      void runGitPublishCurrentBranch(git);
    },
  }),
  'task.pin': (params) => ({
    availability: () =>
      taskAvailability(
        params,
        () => Boolean(getRegisteredTaskData(params.projectId, params.taskId)),
        'Task data is unavailable'
      ),
    presentation: () => {
      const task = getRegisteredTaskData(params.projectId, params.taskId);
      return task?.isPinned
        ? { title: 'Unpin Task', description: 'Remove this task from pinned' }
        : { title: 'Pin Task', description: 'Pin this task to keep it at the top' };
    },
    execute: () => {
      const task = getRegisteredTaskData(params.projectId, params.taskId);
      const taskStore = getTaskStore(params.projectId, params.taskId);
      if (task && taskStore) void taskStore.setPinned(!task.isPinned);
    },
  }),
  'task.archive': (params) => ({
    availability: () => {
      return taskAvailability(
        params,
        () => {
          const data = getRegisteredTaskData(params.projectId, params.taskId);
          return Boolean(data && !data.archivedAt);
        },
        'Task is already archived'
      );
    },
    execute: () => {
      void getTaskManagerStore(params.projectId)
        ?.archiveTask(params.taskId)
        .catch(() => toast.error('Could not archive task'));
    },
  }),
  'task.convertAutomation': (params) => ({
    availability: () => {
      if (getTaskStore(params.projectId, params.taskId)?.state !== 'provisioned') return hidden;
      return getRegisteredTaskData(params.projectId, params.taskId)?.type === 'automation-run'
        ? enabled
        : hidden;
    },
    execute: () => {
      void getTaskStore(params.projectId, params.taskId)?.convertAutomationTask();
    },
  }),
  'task.nextTask': (params) => ({
    availability: () =>
      taskAvailability(
        params,
        () => {
          const entries = getSidebarStore().visibleTaskEntries;
          const index = entries.findIndex(
            (entry) => entry.projectId === params.projectId && entry.taskId === params.taskId
          );
          return index !== -1 && index < entries.length - 1;
        },
        'No next task'
      ),
    execute: () => {
      const entries = getSidebarStore().visibleTaskEntries;
      const index = entries.findIndex(
        (entry) => entry.projectId === params.projectId && entry.taskId === params.taskId
      );
      const next = entries[index + 1];
      if (next) getNavigation().navigate(taskViewDef(next));
    },
  }),
  'task.prevTask': (params) => ({
    availability: () =>
      taskAvailability(
        params,
        () => {
          const entries = getSidebarStore().visibleTaskEntries;
          return (
            entries.findIndex(
              (entry) => entry.projectId === params.projectId && entry.taskId === params.taskId
            ) > 0
          );
        },
        'No previous task'
      ),
    execute: () => {
      const entries = getSidebarStore().visibleTaskEntries;
      const index = entries.findIndex(
        (entry) => entry.projectId === params.projectId && entry.taskId === params.taskId
      );
      const previous = entries[index - 1];
      if (previous) getNavigation().navigate(taskViewDef(previous));
    },
  }),
} satisfies ViewScopeImpl<typeof taskViewScope>;

export function TaskScope({
  projectId,
  taskId,
  activate = true,
  children,
}: {
  readonly projectId: string;
  readonly taskId: string;
  /**
   * Whether this scope instance becomes the logically active scope. Surfaces that mount several
   * tasks at once pass `true` for the one the user is working in; the default keeps the
   * navigation-owned task view always active.
   */
  readonly activate?: boolean;
  readonly children: ReactNode;
}) {
  const { instance } = useViewScope<typeof taskViewScope>(
    taskViewScope({ projectId, taskId }),
    taskScopeImplementation
  );

  useLayoutEffect(() => {
    if (instance && activate) scopes.activate(instance);
  }, [instance, activate]);

  if (!instance) return null;
  return <ViewScopeInstanceProvider instance={instance}>{children}</ViewScopeInstanceProvider>;
}
