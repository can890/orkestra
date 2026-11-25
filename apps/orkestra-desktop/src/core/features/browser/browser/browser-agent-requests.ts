import { comparer, observable, reaction, runInAction, when } from 'mobx';
import { browserAgentActivity } from '@core/features/browser/api/browser/browser-agent-activity';
import { browserPointerStore } from '@core/features/browser/api/browser/browser-pointer-store';
import {
  browserRightPanelStore,
  type OpenBrowserTabOptions,
  type TaskBrowserIdentity,
} from '@core/features/browser/api/browser/browser-right-panel-store';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import {
  asAvailableProject,
  getProjectManagerStore,
  getProjectStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { getAppSettingValueSnapshot } from '@core/features/settings/api/browser/app-settings-client';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { agentBrowserProfileSelection } from '@core/primitives/browser/api';
import type {
  BrowserAgentRequestReply,
  BrowserEvent,
  BrowserTaskActiveTabs,
} from '@core/primitives/browser/api';
import { log } from '@core/primitives/logging/browser/logger';

/** Görev düzeninin hazır olmasını bekleme süresi; ana sürecin 20 sn zaman aşımından kısa. */
export const AGENT_TAB_LAYOUT_WAIT_MS = 15_000;

export type BrowserAgentRequestDeps = {
  isTaskReady(projectId: string, taskId: string): boolean;
  activateTask(projectId: string, taskId: string): Promise<string | null>;
  agentProfileId?(): string | undefined;
  isRightPanelOpen?(projectId: string, taskId: string): boolean;
  openTab?(identity: TaskBrowserIdentity, options?: OpenBrowserTabOptions): string;
  activateTab?(browserId: string): boolean;
  closeTab?(browserId: string): void;
  hasTab?(browserId: string): boolean;
  layoutWaitMs?: number;
};

type AgentTabRequestEvent = Extract<
  BrowserEvent,
  { type: 'open-requested' | 'activate-requested' | 'close-requested' }
>;

/**
 * Ana süreçten gelen ajan sekme isteklerini (aç, öne getir, kapat) ve canlı tarayıcı olaylarını
 * karşılar. Sağ panel kapalıysa ajan sekmesi T3 Code tarzında yüzen mini pencere olarak açılır.
 */
export function createBrowserAgentRequestHandler(deps: BrowserAgentRequestDeps) {
  const layoutWaitMs = deps.layoutWaitMs ?? AGENT_TAB_LAYOUT_WAIT_MS;
  const isRightPanelOpen =
    deps.isRightPanelOpen ??
    ((projectId: string, taskId: string) => browserRightPanelStore.isOpen(projectId, taskId));
  const openTab =
    deps.openTab ??
    ((identity: TaskBrowserIdentity, options?: OpenBrowserTabOptions) =>
      browserRightPanelStore.openTab(identity, options));
  const activateTab =
    deps.activateTab ?? ((browserId: string) => browserRightPanelStore.activateTabById(browserId));
  const hasTab = deps.hasTab ?? ((browserId: string) => browserRightPanelStore.hasTab(browserId));
  const closeTab =
    deps.closeTab ??
    ((browserId: string) => {
      const owner = browserRightPanelStore.taskForBrowser(browserId);
      if (owner) {
        browserRightPanelStore.closeTab(owner.projectId, owner.taskId, browserId);
      }
    });

  async function ensureTaskReady(projectId: string, taskId: string): Promise<void> {
    if (deps.isTaskReady(projectId, taskId)) return;

    const failure = observable.box<string | null>(null);
    void deps.activateTask(projectId, taskId).then(
      (message) => runInAction(() => failure.set(message)),
      (error: unknown) => runInAction(() => failure.set(errorMessage(error)))
    );
    try {
      await when(() => deps.isTaskReady(projectId, taskId) || failure.get() !== null, {
        timeout: layoutWaitMs,
      });
    } catch {
      throw new Error(`Task ${taskId} did not become ready in the Orkestra window in time.`);
    }
    if (deps.isTaskReady(projectId, taskId)) return;
    throw new Error(failure.get() ?? `Task ${taskId} is not available in the Orkestra window.`);
  }

  async function handleRequest(event: AgentTabRequestEvent): Promise<BrowserAgentRequestReply> {
    switch (event.type) {
      case 'open-requested': {
        await ensureTaskReady(event.projectId, event.taskId);
        const panelOpen = isRightPanelOpen(event.projectId, event.taskId);
        const browserId = runInAction(() => {
          const opened = openTab(
            {
              projectId: event.projectId,
              workspaceId: event.workspaceId,
              taskId: event.taskId,
            },
            {
              initialUrl: event.url,
              activate: event.activate,
              profileId: deps.agentProfileId?.(),
              mode: panelOpen ? 'panel' : 'mini-player',
            }
          );
          browserAgentActivity.markAgentOpened(opened);
          return opened;
        });
        return { requestId: event.requestId, ok: true, browserId };
      }
      case 'activate-requested': {
        if (!hasTab(event.browserId)) {
          return {
            requestId: event.requestId,
            ok: false,
            error: `Browser tab ${event.browserId} is not open.`,
          };
        }
        runInAction(() => activateTab(event.browserId));
        return { requestId: event.requestId, ok: true, browserId: event.browserId };
      }
      case 'close-requested': {
        if (hasTab(event.browserId)) {
          runInAction(() => closeTab(event.browserId));
        }
        return { requestId: event.requestId, ok: true, browserId: event.browserId };
      }
    }
  }

  return {
    async handle(event: BrowserEvent): Promise<BrowserAgentRequestReply | null> {
      switch (event.type) {
        case 'agent-activity':
          browserAgentActivity.markActive(event.browserId);
          return null;
        case 'pip-state-changed':
          browserSessionStore.updateSession(event.browserId, { pictureInPicture: event.open });
          return null;
        case 'audio-state-changed':
          browserSessionStore.updateSession(event.browserId, {
            audible: event.audible,
            audioMuted: event.muted,
          });
          return null;
        case 'find-result':
          browserPointerStore.setFindResult(event.browserId, {
            activeMatchOrdinal: event.activeMatchOrdinal,
            matches: event.matches,
            finalUpdate: event.finalUpdate,
          });
          return null;
        case 'controller-changed':
          browserSessionStore.updateSession(event.browserId, { controller: event.controller });
          return null;
        case 'agent-pointer':
          browserPointerStore.setPointer(event.browserId, {
            x: event.x,
            y: event.y,
            action: event.action,
            at: event.at,
          });
          return null;
        case 'open-requested':
        case 'activate-requested':
        case 'close-requested':
          try {
            return await handleRequest(event);
          } catch (error) {
            return { requestId: event.requestId, ok: false, error: errorMessage(error) };
          }
        default:
          return null;
      }
    },
  };
}

export function collectTaskActiveBrowsers(): BrowserTaskActiveTabs[] {
  return browserRightPanelStore.collectActiveBrowsers();
}

export const defaultBrowserAgentRequestDeps: BrowserAgentRequestDeps = {
  isTaskReady(projectId, taskId) {
    try {
      const composition = getTaskComposition(projectId, taskId);
      return Boolean(composition?.isPaneLayoutHydrated);
    } catch {
      return false;
    }
  },
  activateTask: activateTaskInBackground,
  agentProfileId: () => agentBrowserProfileSelection(getAppSettingValueSnapshot('browser')),
};

async function activateTaskInBackground(projectId: string, taskId: string): Promise<string | null> {
  if (!asAvailableProject(getProjectStore(projectId))) {
    try {
      await getProjectManagerStore().hydrateProjectContext(projectId);
    } catch (error) {
      return `Project ${projectId} is not available: ${errorMessage(error)}`;
    }
  }
  const manager = getTaskManagerStore(projectId);
  if (!manager) return `Project ${projectId} is not available in the Orkestra window.`;
  const outcome = await manager.provisionTask(taskId);
  switch (outcome.kind) {
    case 'active':
      return null;
    case 'deferred':
      return `The workspace host of task ${taskId} is not reachable right now.`;
    case 'skipped':
      return outcome.reason === 'task-missing'
        ? `Task ${taskId} was not found.`
        : `Task ${taskId} cannot be activated.`;
    case 'failed':
      return `Task ${taskId} could not be activated: ${outcome.message}`;
  }
}

export function wireBrowserAgentRequests(
  deps: BrowserAgentRequestDeps = defaultBrowserAgentRequestDeps
): () => void {
  const handler = createBrowserAgentRequestHandler(deps);
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let stopActiveSync: (() => void) | undefined;

  void getBrowserClient()
    .then(async (client) => {
      await client.syncSessions({ browserIds: Array.from(browserSessionStore.sessions.keys()) });
      if (disposed) return;
      stopActiveSync = reaction(
        () => collectTaskActiveBrowsers(),
        (tasks) => {
          void client.syncTaskActiveBrowsers({ tasks }).catch((error: unknown) => {
            log.warn('Failed to sync active browser tabs', error);
          });
        },
        { equals: comparer.structural, fireImmediately: true }
      );
      const nextUnsubscribe = await client.events.subscribe(undefined, {
        onEvent: (event) => {
          void handler
            .handle(event)
            .then((reply) => (reply ? client.resolveAgentRequest(reply) : undefined))
            .catch((error: unknown) => log.warn('Failed to answer a browser agent request', error));
        },
        onGap: () => {},
      });
      if (disposed) nextUnsubscribe();
      else unsubscribe = nextUnsubscribe;
    })
    .catch((error: unknown) => log.error('Failed to wire browser agent requests', error));

  return () => {
    disposed = true;
    unsubscribe?.();
    stopActiveSync?.();
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
